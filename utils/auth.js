import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../middleware/auth.js';

// Extract clientId from JWT token
export const getClientIdFromToken = async (req) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    
    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Debug - Token decoded:', { userId: decoded.userId, role: decoded.role, clientId: decoded.clientId });
    
    // For client role, get clientId from the client document
    if (decoded.role === 'client') {
      // If req.user is available (from middleware), use it
      if (req.user?.clientId) {
        console.log('Debug - Client role, using req.user.clientId:', req.user.clientId);
        return req.user.clientId;
      }
      
      // Otherwise, fetch client document to get clientId
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findById(decoded.userId).select('clientId');
      console.log('Debug - Client role, fetched client:', client?.clientId);
      return client?.clientId;
    }
    
    // For user role, get clientId from token or user's client reference
    if (decoded.role === 'user') {
      // If clientId is directly in token, fetch the client's clientId
      if (decoded.clientId) {
        const Client = (await import('../models/Client.js')).default;
        const client = await Client.findById(decoded.clientId).select('clientId');
        console.log('Debug - User role, fetched client for clientId:', decoded.clientId, 'result:', client?.clientId);
        return client?.clientId;
      }
      
      // Fallback to user object if available
      console.log('Debug - User role, fallback to req.user');
      return req.user?.tokenClientId || req.user?.clientId?._id || req.user?.clientId?.clientId;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting clientId from token:', error.message);
    return null;
  }
};