import jwt from 'jsonwebtoken';
import Partner from '../models/Partner.js';
import User from '../models/User.js';

import { JWT_SECRET } from './auth.js';

// Authenticate Partner
export const authenticatePartner = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Authentication required.'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role !== 'partner') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Partner authentication required.'
      });
    }

    const partner = await Partner.findById(decoded.partnerId).select('-password');
    
    if (!partner) {
      return res.status(401).json({
        success: false,
        message: 'Partner not found.'
      });
    }

    if (!partner.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Partner account is inactive.'
      });
    }

    req.partner = partner;
    req.partnerId = partner._id;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Authenticate User
export const authenticateUser = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Authentication required.'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User authentication required.'
      });
    }

    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found.'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User account is inactive.'
      });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Authenticate both Partner and User
export const authenticateBoth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Authentication required.'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role === 'partner') {
      const partner = await Partner.findById(decoded.partnerId).select('-password');
      
      if (!partner || !partner.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Partner not found or inactive.'
        });
      }

      req.partner = partner;
      req.userId = partner._id;
      req.userType = 'partner';
    } else if (decoded.role === 'user') {
      const user = await User.findById(decoded.userId).select('-password');
      
      if (!user || !user.isActive) {
        return res.status(401).json({
          success: false,
          message: 'User not found or inactive.'
        });
      }

      req.user = user;
      req.userId = user._id;
      req.userType = 'user';
    } else {
      return res.status(403).json({
        success: false,
        message: 'Invalid user type.'
      });
    }

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Generate JWT token for partner
export const generatePartnerToken = (partnerId) => {
  return jwt.sign(
    { partnerId, role: 'partner' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
};