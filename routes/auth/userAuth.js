import express from 'express';
import User from '../../models/User.js';
import { generateToken, authenticate } from '../../middleware/auth.js';
import { OAuth2Client } from 'google-auth-library';
import appleSignin from 'apple-signin-auth';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const router = express.Router();

// Apple Sign-In / Check User
router.post('/apple', async (req, res) => {
  try {
    const { identityToken, clientId } = req.body;

    if (!identityToken || !clientId) {
      return res.status(400).json({
        success: false,
        message: 'identityToken and clientId are required',
      });
    }

    let appleUserId = null;
    let email = null;
    let emailVerified = false;

    try {
      const payload = await appleSignin.verifyIdToken(identityToken, {
        audience: 'com.brahmakosh.service',
        ignoreExpiration: false,
      });

      appleUserId = payload.sub;
      email = payload.email || null;
      emailVerified =
        payload.email_verified === 'true' || payload.email_verified === true;
    } catch (err) {
      console.error('Apple token verification failed:', err.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid Apple token',
      });
    }

    if (!appleUserId && !email) {
      return res.status(400).json({
        success: false,
        message: 'Apple identity token missing required claims',
      });
    }

    // Try to find existing user by email (schema enforces unique email)
    let user = null;
    if (email) {
      user = await User.findOne({ email });
    }

    if (user) {
      if (!user.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Account is inactive.',
        });
      }

      if (user.authMethod !== 'firebase') {
        user.authMethod = 'firebase';
        await user.save();
      }

      if (user.clientId) {
        await user.populate('clientId', 'clientId businessName email');
      }

      const token = generateToken(
        user._id,
        'user',
        user.clientId?._id || user.clientId
      );

      return res.status(200).json({
        success: true,
        message: 'Apple sign-in successful',
        data: {
          registered: true,
          user: { ...user.toJSON(), role: 'user' },
          token,
          clientId: user.clientId?.clientId || null,
          clientName: user.clientId?.businessName || null,
        },
      });
    }

    // New user → client should start Mobile OTP flow
    return res.status(200).json({
      success: true,
      message: 'User not registered',
      data: {
        registered: false,
        appleUserId,
        email: email || null,
        emailVerified,
        clientId,
      },
    });
  } catch (error) {
    console.error('Apple auth error:', error);
    res.status(500).json({
      success: false,
      message: 'Apple authentication failed: ' + error.message,
    });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    
    // Log for debugging
    console.log('Google auth request - has idToken:', !!idToken);
    
    if (!idToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'Google ID token is required' 
      });
    }

    // Verify the Google ID token
    let verifiedEmail = null;
    let verifiedName = null;
    let isEmailVerified = false;

    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      
      verifiedEmail = payload.email;
      verifiedName = payload.name;
      isEmailVerified = payload.email_verified;
      
      console.log('Token verified successfully:', {
        email: verifiedEmail,
        name: verifiedName,
        emailVerified: isEmailVerified
      });
    } catch (verifyError) {
      console.error('Token verification failed:', verifyError.message);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid Google token: ' + verifyError.message 
      });
    }

    if (!verifiedEmail) {
      return res.status(400).json({ 
        success: false, 
        message: 'No email found in Google account' 
      });
    }

    // Find or create user
    let user = await User.findOne({ email: verifiedEmail });
    
    if (!user) {
      // Create new user for Google sign-up
      user = new User({
        email: verifiedEmail,
        authMethod: 'google',
        profile: { name: verifiedName || 'Google User' },
        emailVerified: isEmailVerified !== false,
        password: 'google_auth_' + Date.now(), // Temp password for Google users
        loginApproved: true,
        isActive: true,
        registrationStep: 1, // Email verified, but need mobile and profile
        mobileVerified: false
      });
      await user.save();
      console.log('New Google user created:', verifiedEmail);
    } else {
      // Existing user
      if (!user.isActive) {
        return res.status(401).json({ 
          success: false, 
          message: 'Account is inactive.' 
        });
      }
      
      // Update auth method if needed
      if (user.authMethod !== 'google') {
        user.authMethod = 'google';
        await user.save();
      }
    }

    // Populate clientId if exists
    if (user.clientId) {
      await user.populate('clientId', 'clientId businessName email');
    }

    // Generate token with clientId if available
    const token = generateToken(user._id, 'user', user.clientId?._id || user.clientId);
    
    res.json({
      success: true,
      message: 'Google authentication successful',
      data: { 
        user: { 
          ...user.toObject(), 
          role: 'user' 
        }, 
        token,
        clientId: user.clientId?.clientId || null,
        clientName: user.clientId?.businessName || null
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Authentication failed: ' + error.message 
    });
  }
});

// User Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is inactive. Please contact administrator.' 
      });
    }

    // Mobile users (registrationStep === 3) don't need super admin approval
    // They are auto-approved during mobile registration
    if (!user.loginApproved && user.registrationStep !== 3) {
      return res.status(403).json({ 
        success: false, 
        message: 'Login not approved. Please wait for super admin approval.' 
      });
    }

    // Populate clientId if exists
    if (user.clientId) {
      await user.populate('clientId', 'clientId businessName email');
    }

    // Generate token with clientId if available
    const token = generateToken(user._id, 'user', user.clientId?._id || user.clientId);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { ...user.toObject(), role: 'user' },
        token,
        clientId: user.clientId?.clientId || null,
        clientName: user.clientId?.businessName || null
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// User Registration
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, dob, placeOfBirth, profession } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Full name, email and password are required' 
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User already exists with this email' 
      });
    }

    const user = new User({
      email,
      password,
      profile: {
        name: fullName,
        dob: dob ? new Date(dob) : undefined,
        placeOfBirth: placeOfBirth || '',
        profession: profession || ''
      },
      credits: 1000,
      loginApproved: false
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please wait for super admin approval to login.',
      data: { user: user.toObject() }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: req.user
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

export default router;