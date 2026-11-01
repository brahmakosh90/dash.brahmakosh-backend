// src/middleware/auth.js - FIXED VERSION WITH ENHANCED DEBUGGING

import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Client from '../models/Client.js';
import User from '../models/User.js';


// Per-request success logs were synchronous stdout writes on every authenticated call (and printed emails).
// Opt in with AUTH_DEBUG=true when debugging auth; failures are still always logged.
const authDebug = process.env.AUTH_DEBUG === 'true' ? (...args) => console.log(...args) : () => {};
export const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production-to-a-strong-random-string';

/**
 * Enhanced Authentication Middleware
 * Works with all user types: super_admin, admin, client, and user
 * FIXED: Ensures role is always properly set as a string
 */
export const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.header('Authorization') || req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ 
        success: false, 
        message: 'No authorization header provided. Authentication required.' 
      });
    }

    // Handle both "Bearer token" and just "token" formats
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.replace('Bearer ', '') 
      : authHeader;
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'No token provided. Authentication required.' 
      });
    }

    // Verify and decode token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (verifyError) {
      if (verifyError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Please login again.',
          error: process.env.NODE_ENV === 'development' ? verifyError.message : undefined
        });
      }
      if (verifyError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. Authorization denied.',
          error: process.env.NODE_ENV === 'development' ? verifyError.message : undefined
        });
      }
      throw verifyError;
    }

    // Extract user ID - handle both formats
    // Old format: { userId, role, clientId }
    // New format: { id, role, email }
    const userId = decoded.userId || decoded.id;
    const userRole = decoded.role;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token: User ID missing. Authorization denied.'
      });
    }

    if (!userRole) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token: Role missing. Authorization denied.'
      });
    }

    authDebug('[Auth Middleware] Token decoded:', {
      userId,
      role: userRole,
      email: decoded.email,
      clientId: decoded.clientId,
      tokenFormat: decoded.userId ? 'old' : 'new'
    });
    
    // Fetch user from appropriate model based on role
    let user = null;
    let userObject = null; // Store the original Mongoose document
    
    if (userRole === 'super_admin' || userRole === 'admin') {
      userObject = await Admin.findById(userId).select('-password');
      if (userObject) {
        user = userObject.toObject ? userObject.toObject() : userObject;
        user.role = userRole; // CRITICAL: Set role from token
      }
    } 
    else if (userRole === 'client') {
      userObject = await Client.findById(userId).select('-password');
      if (userObject) {
        user = userObject.toObject ? userObject.toObject() : userObject;
        user.role = 'client'; // CRITICAL: Set role explicitly
        // Ensure _id is available
        if (!user._id && userId) {
          user._id = userId;
        }
        authDebug('[Auth Middleware] Client user loaded:', {
          _id: user._id?.toString(),
          clientId: user.clientId,
          email: user.email,
          role: user.role,
          isActive: user.isActive
        });
      }
    } 
    else if (userRole === 'user') {
      userObject = await User.findById(userId)
        .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
        .populate('clientId', 'clientId businessName email');
      
      if (userObject) {
        // CRITICAL FIX: Convert to plain object FIRST
        user = userObject.toObject ? userObject.toObject() : { ...userObject };
        
        // CRITICAL FIX: Set role as plain string AFTER conversion
        user.role = 'user';
        
        // Add clientId from token for backward compatibility
        if (decoded.clientId) {
          user.tokenClientId = decoded.clientId;
        }

        authDebug('[Auth Middleware] User loaded:', {
          _id: user._id?.toString(),
          role: user.role,
          roleType: typeof user.role,
          email: user.email,
          clientId: user.clientId?._id?.toString() || user.tokenClientId,
          isActive: user.isActive,
          loginApproved: user.loginApproved
        });
      }
    }
    else {
      return res.status(401).json({
        success: false,
        message: `Invalid role in token: ${userRole}`
      });
    }
    
    // Check if user exists
    if (!user) {
      console.error('[Auth Middleware] User not found:', { userId, role: userRole });
      return res.status(401).json({ 
        success: false, 
        message: 'User not found. Authorization denied.' 
      });
    }

    // Check if user is active
    if (user.isActive === false) {
      return res.status(401).json({ 
        success: false, 
        message: 'User account is inactive. Please contact support.' 
      });
    }

    // For users, check if login is approved
    if (userRole === 'user' && user.loginApproved === false) {
      return res.status(401).json({
        success: false,
        message: 'Your account is pending approval. Please contact your administrator.'
      });
    }

    // CRITICAL FIX: Triple-check role is set correctly as a plain string
    if (!user.role || user.role !== userRole) {
      user.role = userRole;
    }

    // FINAL VERIFICATION: Ensure role is a string, not an object or undefined
    user.role = String(userRole);

    // Store additional decoded data in request for verification
    req.decodedRole = userRole;
    req.decodedClientId = decoded.clientId;
    req.decodedEmail = decoded.email;

    // Log successful authentication with role verification
    authDebug('[Auth Middleware] Authentication successful:', {
      userId: user._id?.toString(),
      role: user.role,
      roleType: typeof user.role,
      tokenRole: userRole,
      email: user.email || decoded.email,
      roleMatch: user.role === userRole,
      roleIsString: typeof user.role === 'string'
    });

    // CRITICAL: Final check before attaching to request
    if (typeof user.role !== 'string') {
      console.error('[Auth Middleware] CRITICAL ERROR: role is not a string!', {
        role: user.role,
        type: typeof user.role
      });
      user.role = String(userRole);
    }

    // Attach user to request
    req.user = user;
    
    next();

  } catch (error) {
    console.error('[Auth Middleware] Unexpected error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during authentication.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Role-based Authorization Middleware
 * Usage: authorize('admin', 'super_admin') or authorize(['admin', 'super_admin'])
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      console.error('[Auth Middleware] Authorization failed: No user object');
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required. Please login first.' 
      });
    }

    // DIAGNOSTIC LOGGING
    authDebug('[Auth Middleware] Authorization check:', {
      userRole: req.user.role,
      userRoleType: typeof req.user.role,
      allowedRoles: roles,
      userId: req.user._id?.toString()
    });

    // Handle both array and spread arguments
    const allowedRoles = Array.isArray(roles[0]) ? roles[0] : roles;

    // CRITICAL FIX: Ensure role is a string for comparison
    const userRole = String(req.user.role);

    if (!allowedRoles.includes(userRole)) {
      console.log('[Auth Middleware] Authorization failed:', {
        userRole: userRole,
        userRoleOriginal: req.user.role,
        allowedRoles,
        userId: req.user._id?.toString(),
        comparisonResults: allowedRoles.map(r => ({
          role: r,
          matches: r === userRole,
          strictMatches: r === req.user.role
        }))
      });

      return res.status(403).json({ 
        success: false, 
        message: `Access denied. Required role(s): ${allowedRoles.join(', ')}. Your role: ${userRole}` 
      });
    }

    authDebug('[Auth Middleware] Authorization successful:', {
      userRole: userRole,
      userId: req.user._id?.toString(),
      allowedRoles
    });

    next();
  };
};

/**
 * Generate JWT token
 * Supports both old and new token formats
 */
export const generateToken = (userId, role, clientId = null, email = null) => {
  const payload = { 
    userId,  // Old format (for backward compatibility)
    id: userId,  // New format
    role: String(role), // CRITICAL: Ensure role is always a string
    email: email || undefined
  };
  
  // Add clientId to token for users
  if (role === 'user' && clientId) {
    payload.clientId = clientId;
  }
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

/**
 * Verify token without database lookup (for quick checks)
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
};

/**
 * Decode token without verification (use cautiously)
 */
export const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (error) {
    return null;
  }
};

// Aliases for backward compatibility
export const authenticateToken = authenticate;
export const authMiddleware = authenticate;

// Export default for convenience
export default {
  authenticate,
  authorize,
  generateToken,
  verifyToken,
  decodeToken,
  authenticateToken,
  authMiddleware,
  JWT_SECRET
};