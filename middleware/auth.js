import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Client from '../models/Client.js';
import User from '../models/User.js';
import Partner from '../models/Partner.js';
import { getCachedUser, setCachedUser } from '../utils/responseCache.js';
import { getJwtSecretProblem } from '../config/validateEnv.js';


// Per-request success logs were synchronous stdout writes on every authenticated call (and printed emails).
// Opt in with AUTH_DEBUG=true when debugging auth; failures are still always logged.
const authDebug = process.env.AUTH_DEBUG === 'true' ? (...args) => console.log(...args) : () => {};
const fatal = (msg) => {
  console.error(`[Auth] FATAL: ${msg}`);
  process.exit(1);
};

// Hard-fail on a missing secret everywhere, and on a weak/placeholder secret in production.
const resolveJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  const problem = getJwtSecretProblem(secret);
  if (!secret) fatal('JWT_SECRET environment variable is not set');
  if (problem) {
    if (process.env.NODE_ENV === 'production') fatal(problem);
    console.warn(`[Auth] WARNING: ${problem}. This is only tolerated outside production.`);
  }
  return secret;
};

export const JWT_SECRET = resolveJwtSecret();

// Optional previous secret: tokens signed with it still verify, new tokens never use it.
// Enables zero-downtime rotation (set JWT_SECRET_PREVIOUS=<old>, JWT_SECRET=<new>, remove old after tokens expire).
const PREVIOUS_SECRET = (() => {
  const prev = process.env.JWT_SECRET_PREVIOUS;
  if (!prev) return null;
  const problem = getJwtSecretProblem(prev, { label: 'JWT_SECRET_PREVIOUS' });
  if (problem) {
    if (process.env.NODE_ENV === 'production') fatal(problem);
    console.warn(`[Auth] WARNING: ${problem}`);
  }
  return prev;
})();

const verifyWithRotation = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (PREVIOUS_SECRET && err.name === 'JsonWebTokenError' && /signature/i.test(err.message)) {
      return jwt.verify(token, PREVIOUS_SECRET);
    }
    throw err;
  }
};

// Authentication middleware - works with all models
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const rawHeader = authHeader || req.headers.authorization;
    // Accept both "Bearer <token>" and a bare token
    const token = rawHeader?.startsWith('Bearer ') ? rawHeader.slice(7) : rawHeader;
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'No token provided. Authentication required.' 
      });
    }

    let decoded;
    try {
      decoded = verifyWithRotation(token);
    } catch (verifyError) {
      if (verifyError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Please login again.',
          error: process.env.NODE_ENV === 'development' ? verifyError.message : undefined
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Authorization denied.',
        error: process.env.NODE_ENV === 'development' ? verifyError.message : undefined
      });
    }

    // Dual token format: old { userId, role, clientId } and new { id, role, email }
    const tokenUserId = decoded.userId || decoded.id;
    if (!tokenUserId) {
      return res.status(401).json({ success: false, message: 'Invalid token: User ID missing. Authorization denied.' });
    }
    if (!decoded.role) {
      return res.status(401).json({ success: false, message: 'Invalid token: Role missing. Authorization denied.' });
    }
    decoded.userId = tokenUserId;
    req.decodedEmail = decoded.email;

    // Determine model based on role in token
    let user = null;
    if (decoded.role === 'super_admin' || decoded.role === 'admin') {
      user = await Admin.findById(decoded.userId).select('-password');
      if (user) user.role = decoded.role; // Ensure role is set
    } else if (decoded.role === 'client') {
      user = await Client.findById(decoded.userId).select('-password');
      if (user) {
        user.role = 'client';
        // Ensure _id is available
        if (!user._id && decoded.userId) {
          user._id = decoded.userId;
        }
        authDebug('[Auth Middleware] Client user loaded:', {
          _id: user._id?.toString(),
          clientId: user.clientId,
          email: user.email,
          role: user.role,
          isActive: user.isActive
        });
      }
    } else if (decoded.role === 'user') {
      // Check user cache first to avoid DB hit on every request
      const cached = getCachedUser(token);
      if (cached) {
        // Copy: handlers and the role fix-ups below mutate req.user, which must not leak to other requests
        user = { ...cached };
      } else {
        user = await User.findById(decoded.userId)
          .select('-password')
          .populate('clientId', 'clientId businessName email');
        if (user) {
          user = user.toObject ? user.toObject() : user;
          user.role = 'user';
          if (decoded.clientId) user.tokenClientId = decoded.clientId;
          setCachedUser(token, user);
        }
      }
    } else if (decoded.role === 'partner') {
      const partnerId = decoded.partnerId || decoded.userId;
      if (partnerId) {
        user = await Partner.findById(partnerId).select('-password');
        if (user) {
          user.role = 'partner';
        }
      }
    }
    else {
      return res.status(401).json({ success: false, message: `Invalid role in token: ${decoded.role}` });
    }
    
    authDebug('[Auth Middleware] User found:', {
      userId: user?._id,
      role: user?.role,
      email: user?.email,
      clientId: user?.role === 'client' ? user?.clientId : (user?.clientId?._id || user?.tokenClientId),
      isActive: user?.isActive
    });
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found.' 
      });
    }

    // For non-partner roles, block inactive accounts.
    // Partners may be inactive during registration (awaiting client approval) but still need access to some flows.
    if (user.role !== 'partner' && !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User account is inactive.'
      });
    }

    // Ensure role is always set - prioritize token role over user object role
    if (!user.role || user.role !== decoded.role) {
      user.role = decoded.role;
    }

    // Final check - ensure role is a string and exactly matches token role
    if (user.role !== decoded.role) {
      user.role = decoded.role;
    }

    // Store decoded role and clientId in request for additional verification
    req.decodedRole = decoded.role;
    req.decodedClientId = decoded.clientId;

    authDebug('[Auth Middleware] Authentication successful:', {
      userId: user._id?.toString(),
      role: user.role,
      tokenRole: decoded.role,
      clientId: user.role === 'client' ? user.clientId : (user.clientId?.clientId || decoded.clientId),
      roleMatch: user.role === decoded.role
    });

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      message: 'Invalid or expired token.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Role-based authorization middleware
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required.' 
      });
    }

    // Handle both array and spread arguments - FIX THE BUG
    const allowedRoles = Array.isArray(roles[0]) ? roles[0] : roles;

    authDebug('[Authorization Check]', {
      userRole: req.user.role,
      allowedRoles: allowedRoles,
      isAuthorized: allowedRoles.includes(req.user.role)
    });

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Insufficient permissions.' 
      });
    }

    next();
  };
};

// Token lifetimes are configurable; defaults preserve the previous 7d behaviour.
// Recommended hardening once clients support refresh: JWT_EXPIRES_IN=24h, JWT_ADMIN_EXPIRES_IN=1h.
const expiryFor = (role) =>
  role === 'admin' || role === 'super_admin'
    ? process.env.JWT_ADMIN_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '7d'
    : process.env.JWT_EXPIRES_IN || '7d';

/**
 * Generate a JWT. Payload carries both formats (userId + id) so old and new consumers work.
 */
export const generateToken = (userId, role, clientId = null, email = null) => {
  const payload = { userId, id: userId, role: String(role) };
  if (email) payload.email = email;
  if (clientId) payload.clientId = clientId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiryFor(role) });
};

/** Verify a token without a database lookup. Returns null when invalid. */
export const verifyToken = (token) => {
  try {
    return verifyWithRotation(token);
  } catch {
    return null;
  }
};

/** Decode without verification (never use for authorization decisions). */
export const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

// Aliases kept for backward compatibility
export const authenticateToken = authenticate;
export const authMiddleware = authenticate;

export default { authenticate, authorize, generateToken, verifyToken, decodeToken, authenticateToken, authMiddleware, JWT_SECRET };
