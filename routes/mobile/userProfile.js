import express from 'express';
import multer from 'multer';

import { v4 as uuidv4 } from 'uuid';
import User from '../../models/User.js';
import Credit from '../../models/Credit.js';
import { OAuth2Client } from 'google-auth-library';
import Client from '../../models/Client.js';
import { generateToken, authenticate } from '../../middleware/auth.js';
import astrologyService from '../../services/astrologyService.js';
import {
  generateOTP,
  getOTPExpiry,
  validateOTP,
  sendEmailOTP,
  sendMobileOTP,
  sendWhatsAppOTP,
} from '../../utils/otp.js';
import { verifyFirebaseToken, isFirebaseAuthEnabled } from '../../utils/firebaseAuth.js';
import { getPresignedUrl, generateUploadUrl, extractS3KeyFromUrl } from '../../utils/storage.js';

const router = express.Router();

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const isS3Url = (value) => typeof value === 'string' && value.includes('amazonaws.com/');
const decodeKey = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const buildGoogleAvatarUrlFromKey = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = decodeKey(value);
  if (!normalized.startsWith('a/')) return null;
  return `https://lh3.googleusercontent.com/${normalized}`;
};

const normalizeStoredProfileImageToKey = async (user) => {
  if (!user?.profileImage || typeof user.profileImage !== 'string') {
    return null;
  }

  if (!isHttpUrl(user.profileImage)) {
    const decoded = decodeKey(user.profileImage);
    if (decoded !== user.profileImage) {
      user.profileImage = decoded;
      await user.save();
      return decoded;
    }
    return user.profileImage;
  }

  if (!isS3Url(user.profileImage)) {
    return null;
  }

  const extractedKey = extractS3KeyFromUrl(user.profileImage);
  if (!extractedKey || extractedKey === user.profileImage) {
    return extractedKey || null;
  }

  user.profileImage = extractedKey;
  await user.save();
  return extractedKey;
};

const resolveProfileImageUrl = async (user) => {
  if (!user?.profileImage) return null;

  if (isHttpUrl(user.profileImage) && !isS3Url(user.profileImage)) {
    return user.profileImage;
  }

  try {
    return await getPresignedUrl(user.profileImage);
  } catch (error) {
    if (user.authMethod === 'google') {
      const googleAvatarUrl = buildGoogleAvatarUrlFromKey(user.profileImage);
      if (googleAvatarUrl) return googleAvatarUrl;
    }
    throw error;
  }
};

// Multer config for direct image uploads (memory storage, 5MB limit, images only)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// Normalize mobile to +91XXXXXXXXXX format
const normalizeMobile = (mobile) => {
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (String(mobile).startsWith('+')) return `+${digits}`;
  return `+${digits}`;
};

// Helper function to validate and get client
async function validateClientId(clientCode) {
  if (!clientCode) {
    throw new Error('Client ID is required');
  }

  const client = await Client.findOne({ clientId: clientCode.toUpperCase() });
  
  if (!client) {
    throw new Error('Invalid Client ID');
  }

  if (!client.isActive) {
    throw new Error('Client account is inactive');
  }

  return client;
}

// backend/src/routes/mobile/userProfile.js
// Update the Google Sign-In endpoint

// Google Sign-In Registration/Login - ONLY VERIFIES STEP 1
router.post('/register/google', async (req, res) => {
  try {
    const { credential, clientId: clientCode } = req.body;

    if (!credential) {
      return res.status(400).json({ 
        success: false, 
        message: 'Google credential is required' 
      });
    }

    if (!clientCode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Client ID is required' 
      });
    }

    // Verify Google token
    let payload;
    try {
      const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error('Google token verification failed:', verifyError);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid Google credential' 
      });
    }

    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;
    const emailVerified = payload.email_verified;

    // Find client
    const clientDoc = await Client.findOne({ clientId: clientCode.toUpperCase() });
    if (!clientDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'Invalid client ID. Please contact your organization.' 
      });
    }

    if (!clientDoc.isActive) {
      return res.status(403).json({ 
        success: false, 
        message: 'Client account is inactive. Please contact administrator.' 
      });
    }

    // Check if user exists
    let user = await User.findOne({ 
      email, 
      clientId: clientDoc._id
    });
    
    if (user) {
      // Existing user
      if (user.registrationStep === 3) {
        // Fully registered - perform login
        const token = generateToken(user._id, 'user', user.clientId);
        
        return res.json({
          success: true,
          message: 'Login successful',
          registrationComplete: true,
          data: {
            token,
            email: user.email,
            user: {
              id: user._id,
              email: user.email,
              name: user.profile?.name || name,
              mobile: user.mobile,
              profileImage: user.profileImage,
              profile: user.profile
            },
            clientId: clientDoc.clientId,
            clientName: clientDoc.businessName || clientDoc.name
          }
        });
      } else {
        // Registration incomplete - update Step 1 only
        user.emailVerified = true;
        user.authMethod = 'google';
        if (name && !user.profile?.name) {
          user.profile = user.profile || {};
          user.profile.name = name;
        }
        if (picture) {
          user.profileImage = picture;
        }
        await user.save();

        return res.json({
          success: true,
          message: 'Email verified with Google. Please continue with mobile verification (Step 2).',
          registrationComplete: false,
          data: {
            email: user.email,
            emailVerified: true,
            registrationStep: user.registrationStep,
            mobileVerified: user.mobileVerified || false,
            profileCompleted: false,
            nextStep: 'mobile_verification',
            clientId: clientDoc.clientId,
            clientName: clientDoc.businessName || clientDoc.name
          }
        });
      }
    } else {
      // New user - create with ONLY Step 1 verified
      user = new User({
        email,
        password: 'google_auth_' + Date.now(),
        authMethod: 'google',
        profile: {
          name: name
        },
        profileImage: picture,
        clientId: clientDoc._id,
        emailVerified: true, // Step 1 verified via Google
        mobileVerified: false, // Step 2 NOT verified
        registrationStep: 1, // Only Step 1 complete
        loginApproved: false, // Not approved until all steps complete
        isActive: false // Not active until all steps complete
      });

      await user.save();

      return res.status(201).json({
        success: true,
        message: 'Email verified with Google. Please continue withmobile verification (Step 2).',
registrationComplete: false,
data: {
email: user.email,
emailVerified: true,
registrationStep: 1,
mobileVerified: false,
profileCompleted: false,
nextStep: 'mobile_verification',
clientId: clientDoc.clientId,
clientName: clientDoc.businessName || clientDoc.name
}
});
}
} catch (error) {
console.error('Google Sign-In Error:', error);
res.status(500).json({
success: false,
message: error.message || 'Google authentication failed'
});
}
});
// ============================================
// FIREBASE AUTHENTICATION
// ============================================

/**
 * Sign Up with Firebase
 * POST /api/mobile/user/register/firebase
 * Body: { idToken, clientId }
 */
router.post('/register/firebase', async (req, res) => {
  try {
    const { idToken, clientId: clientCode } = req.body;

    if (!idToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase ID token is required' 
      });
    }

    if (!isFirebaseAuthEnabled()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase Authentication is not configured' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    // Verify Firebase token and get user info
    const firebaseUser = await verifyFirebaseToken(idToken);

    if (!firebaseUser.email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase account must have an email address' 
      });
    }
    
    const isEmailVerified = firebaseUser.emailVerified || firebaseUser.providerId === 'google.com';

    // Check if user already exists for this client
    let user = await User.findOne({ 
      clientId: client._id,
      $or: [
        { email: firebaseUser.email },
        { firebaseId: firebaseUser.firebaseId }
      ]
    });

    if (user) {
      if (user.registrationStep === 3) {
        return res.status(400).json({ 
          success: false, 
          message: 'User already registered. Please use sign in with Firebase instead.' 
        });
      }

      user.firebaseId = firebaseUser.firebaseId;
      user.authMethod = 'firebase';
      user.emailVerified = isEmailVerified;
      
      if (firebaseUser.name && !user.profile?.name) {
        user.profile = user.profile || {};
        user.profile.name = firebaseUser.name;
      }
      
      await user.save();
    } else {
      user = new User({
        email: firebaseUser.email,
        firebaseId: firebaseUser.firebaseId,
        authMethod: 'firebase',
        emailVerified: isEmailVerified,
        password: 'temp_password_' + Date.now(),
        registrationStep: 0,
        clientId: client._id,
        clientCode: client.clientId,
        profile: {
          name: firebaseUser.name || ''
        }
      });
      await user.save();
    }

    res.json({
      success: true,
      message: 'Firebase sign up successful. You can proceed with mobile verification or profile completion.',
      data: {
        user: { ...user.toObject(), role: 'user' },
        email: user.email,
        emailVerified: user.emailVerified,
        mobileVerified: user.mobileVerified || false,
        profileCompleted: user.registrationStep === 3,
        authMethod: 'firebase',
        clientId: client.clientId,
        clientName: client.businessName
      }
    });
  } catch (error) {
    console.error('Firebase sign up error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Firebase sign up failed' 
    });
  }
});

/**
 * Sign In with Firebase
 * POST /api/mobile/user/login/firebase
 * Body: { idToken, clientId }
 */
router.post('/login/firebase', async (req, res) => {
  try {
    const { idToken, clientId: clientCode } = req.body;

    if (!idToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase ID token is required' 
      });
    }

    if (!isFirebaseAuthEnabled()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase Authentication is not configured' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    // Verify Firebase token and get user info
    const firebaseUser = await verifyFirebaseToken(idToken);

    if (!firebaseUser.email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Firebase account must have an email address' 
      });
    }

    // Find user by email or Firebase ID for this specific client
    let user = await User.findOne({ 
      clientId: client._id,
      $or: [
        { email: firebaseUser.email },
        { firebaseId: firebaseUser.firebaseId }
      ]
    });

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found for this client. Please sign up first.' 
      });
    }

    if (user.registrationStep < 3) {
      return res.status(400).json({ 
        success: false, 
        message: 'Registration incomplete. Please complete profile.',
        data: {
          registrationStep: user.registrationStep,
          emailVerified: user.emailVerified,
          mobileVerified: user.mobileVerified,
          profileCompleted: user.registrationStep === 3
        }
      });
    }

    if (!user.firebaseId) {
      user.firebaseId = firebaseUser.firebaseId;
      user.authMethod = 'firebase';
      await user.save();
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is inactive. Please contact administrator.' 
      });
    }

    const token = generateToken(user._id, 'user', user.clientId);

    res.json({
      success: true,
      message: 'Firebase sign in successful',
      data: {
        user: { ...user.toObject(), role: 'user' },
        token,
        authMethod: 'firebase',
        clientId: client.clientId,
        clientName: client.businessName
      }
    });
  } catch (error) {
    console.error('Firebase sign in error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Firebase sign in failed' 
    });
  }
});

// ============================================
// REGISTRATION FLOW - MULTI-STEP
// ============================================

/**
 * STEP 1: Mobile OTP Verification
 * POST /api/mobile/user/register/step1
 * Body: { mobile, otpMethod, clientId }
 */
router.post('/register/step1', async (req, res) => {
  try {
    const { mobile: rawMobile, otpMethod = 'whatsapp', clientId: clientCode } = req.body;

    if (!rawMobile) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    const mobile = normalizeMobile(rawMobile);
    const client = await validateClientId(clientCode);

    // Check if mobile already fully registered
    const existingUser = await User.findOne({ clientId: client._id, mobile, registrationStep: 3 });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Mobile number already registered. Please login.' });
    }

    const otp = generateOTP();
    const otpExpiry = getOTPExpiry();

    let user = await User.findOne({ clientId: client._id, mobile }).select('+mobileOtp +mobileOtpExpiry');
    if (user) {
      user.mobileOtp = otp;
      user.mobileOtpExpiry = otpExpiry;
      user.mobileOtpMethod = otpMethod;
      await user.save();
    } else {
      user = new User({
        mobile,
        email: `mobile_${mobile.replace(/\+/g, '')}${Date.now()}@temp.com`,
        password: 'temp_password_' + Date.now(),
        mobileOtp: otp,
        mobileOtpExpiry: otpExpiry,
        mobileOtpMethod: otpMethod,
        registrationStep: 0,
        mobileVerified: false,
        clientId: client._id,
        clientCode: client.clientId
      });
      await user.save();
    }

    const otpResult = await sendMobileOTP(mobile, otp, otpMethod);
    if (!otpResult.success) {
      console.warn('Mobile OTP sending had issues:', otpResult.message);
    }

    res.json({
      success: true,
      message: `OTP sent to ${mobile} via ${otpMethod.toUpperCase()}`,
      data: { mobile, otpMethod, clientId: client.clientId, clientName: client.businessName }
    });
  } catch (error) {
    console.error('Step 1 registration error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send OTP' });
  }
});

/**
 * STEP 1 VERIFY: Verify Mobile OTP
 * POST /api/mobile/user/register/step1/verify
 * Body: { mobile, otp, clientId }
 */
router.post('/register/step1/verify', async (req, res) => {
  try {
    const { mobile: rawMobile, otp, clientId: clientCode } = req.body;

    if (!rawMobile || !otp) {
      return res.status(400).json({ success: false, message: 'Mobile and OTP are required' });
    }

    const mobile = normalizeMobile(rawMobile);
    const client = await validateClientId(clientCode);

    const user = await User.findOne({ clientId: client._id, mobile }).select('+mobileOtp +mobileOtpExpiry');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found. Please send OTP first.' });
    }

    const validation = validateOTP(user.mobileOtp, otp, user.mobileOtpExpiry);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    user.mobileVerified = true;
    user.registrationStep = 1;
    user.mobileOtp = undefined;
    user.mobileOtpExpiry = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'Mobile verified successfully',
      data: {
        mobile: user.mobile,
        mobileVerified: true,
        registrationStep: 1,
        nextStep: 'complete_profile',
        clientId: client.clientId
      }
    });
  } catch (error) {
    console.error('Step 1 verify error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to verify OTP' });
  }
});

/**
 * STEP 2: Mobile OTP Verification
 * POST /api/mobile/user/register/step2
 * Body: { email, mobile, otpMethod: 'twilio' | 'gupshup' | 'whatsapp', clientId }
 */
router.post('/register/step2', async (req, res) => {
  try {
    const { email, mobile, otpMethod, clientId: clientCode } = req.body;

    if (!mobile) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mobile number is required' 
      });
    }

    if (!otpMethod || !['twilio', 'gupshup', 'whatsapp'].includes(otpMethod)) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP method is required (twilio, gupshup, or whatsapp)' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    // Validate mobile format
    const mobileRegex = /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,9}$/;
    if (!mobileRegex.test(mobile)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid mobile number format' 
      });
    }

    // Find user by email for this client
    let user = null;
    if (email) {
      user = await User.findOne({ 
        clientId: client._id, 
        email 
      }).select('+mobileOtp +mobileOtpExpiry');
    }
    
    if (!user) {
      user = await User.findOne({ 
        clientId: client._id, 
        mobile 
      }).select('+mobileOtp +mobileOtpExpiry');
    }
    
    if (!user) {
      user = new User({
        email: email || `mobile_${mobile}@temp.com`,
        password: 'temp_password_' + Date.now(),
        registrationStep: 0,
        emailVerified: false,
        mobileVerified: false,
        clientId: client._id,
        clientCode: client.clientId
      });
    }

    // Check if mobile is already registered to another user in this client
    const existingMobileUser = await User.findOne({ 
      clientId: client._id,
      mobile, 
      _id: { $ne: user._id },
      mobileVerified: true 
    });
    
    if (existingMobileUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mobile number already registered for this client' 
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiry = getOTPExpiry();

    user.mobile = mobile;
    user.mobileOtp = otp;
    user.mobileOtpExpiry = otpExpiry;
    user.mobileOtpMethod = otpMethod;
    if (!user.mobileVerified) {
      user.mobileVerified = false;
    }
    await user.save();

    // Send OTP based on method
    let otpResult;
    if (otpMethod === 'whatsapp') {
      otpResult = await sendMobileOTP(mobile, otp, 'whatsapp');
    } else if (otpMethod === 'gupshup') {
      otpResult = await sendMobileOTP(mobile, otp, 'gupshup');
    } else {
      otpResult = await sendMobileOTP(mobile, otp, 'twilio');
    }
    
    if (!otpResult.success) {
      console.warn(`${otpMethod.toUpperCase()} OTP sending had issues, but continuing:`, otpResult.message);
    }

    res.json({
      success: true,
      message: `OTP sent to your mobile via ${otpMethod.toUpperCase()}. Please verify to continue.`,
      data: {
        email: user.email,
        mobile: user.mobile,
        otpMethod,
        registrationStep: 2,
        clientId: client.clientId
      }
    });
  } catch (error) {
    console.error('Step 2 registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to send mobile OTP' 
    });
  }
});

/**
 * STEP 2 VERIFY: Verify Mobile OTP
 * POST /api/mobile/user/register/step2/verify
 * Body: { email, mobile, otp, clientId }
 */
router.post('/register/step2/verify', async (req, res) => {
  try {
    const { email, mobile, otp, clientId: clientCode } = req.body;

    if (!otp || (!email && !mobile)) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP and either email or mobile number are required' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    // Find user by email or mobile for this client
    let user = null;
    if (email) {
      user = await User.findOne({ 
        clientId: client._id, 
        email 
      }).select('+mobileOtp +mobileOtpExpiry');
    }
    if (!user && mobile) {
      user = await User.findOne({ 
        clientId: client._id, 
        mobile 
      }).select('+mobileOtp +mobileOtpExpiry');
    }
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found. Please send mobile OTP first (step 2).' 
      });
    }
    
    if (!user.mobileOtp) {
      return res.status(400).json({ 
        success: false, 
        message: 'No OTP found. Please send mobile OTP first (step 2).' 
      });
    }

    // Validate OTP
    const validation = validateOTP(user.mobileOtp, otp, user.mobileOtpExpiry);
    if (!validation.valid) {
      return res.status(400).json({ 
        success: false, 
        message: validation.message 
      });
    }

    // Mark mobile as verified
    user.mobileVerified = true;
    user.mobileOtp = undefined;
    user.mobileOtpExpiry = undefined;
    user.mobileOtpMethod = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'Mobile verified successfully',
      data: {
        email: user.email,
        mobile: user.mobile,
        mobileVerified: true,
        emailVerified: user.emailVerified || false,
        profileCompleted: user.registrationStep === 3,
        clientId: client.clientId
      }
    });
  } catch (error) {
    console.error('Mobile OTP verification error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to verify mobile OTP' 
    });
  }
});

/**
 * STEP 3: Complete Profile
 * POST /api/mobile/user/register/step3
 * Body: { 
 *   email (required),
 *   clientId (required),
 *   name (optional),
 *   dob (optional),
 *   timeOfBirth (optional),
 *   placeOfBirth (optional),
 *   latitude (optional),
 *   longitude (optional),
 *   gowthra (optional)
 * }
 */
router.post('/register/step3', async (req, res) => {
  try {
    const { 
      mobile,
      email,
      password,
      clientId: clientCode,
      name, 
      dob, 
      timeOfBirth, 
      placeOfBirth,
      latitude,
      longitude,
      gowthra,
      profession
    } = req.body;

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    const normalizedMobile = normalizeMobile(mobile);

    // Find user by mobile
    let user = await User.findOne({ clientId: client._id, mobile: normalizedMobile });
    
    // If user doesn't exist, create one
    if (!user) {
      user = new User({
        mobile: normalizedMobile,
        email: email || `mobile_${normalizedMobile.replace(/\+/g, '')}@temp.com`,
        password: password || 'temp_password_' + Date.now(),
        registrationStep: 0,
        mobileVerified: true,
        clientId: client._id,
        clientCode: client.clientId
      });
    }

    // Update email and password if provided
    if (email) user.email = email;
    if (password) user.password = password;

    // Update profile information
    if (!user.profile) {
      user.profile = {};
    }
    
    if (name) user.profile.name = name;
    if (dob) user.profile.dob = new Date(dob);
    if (timeOfBirth) user.profile.timeOfBirth = timeOfBirth;
    if (placeOfBirth) user.profile.placeOfBirth = placeOfBirth;
    if (latitude !== undefined) user.profile.latitude = parseFloat(latitude);
    if (longitude !== undefined) user.profile.longitude = parseFloat(longitude);
    if (gowthra) user.profile.gowthra = gowthra;
    if (profession) user.profile.profession = profession;

    // Mark registration as complete
    user.registrationStep = 3;
    user.loginApproved = true;
    user.isActive = true;
    await user.save();

    // Signup bonus: add 500 credits once per user and log in Credit model
    const SIGNUP_CREDITS = 500;
    const alreadyGranted = await Credit.findOne({
      userId: user._id,
      description: 'Signup bonus'
    });
    if (!alreadyGranted) {
      const previousBalance = user.credits ?? 0;
      const newBalance = previousBalance + SIGNUP_CREDITS;
      user.credits = newBalance;
      await user.save();
      await Credit.create({
        userId: user._id,
        amount: SIGNUP_CREDITS,
        previousBalance,
        newBalance,
        addedBy: user._id,
        addedByRole: 'payment',
        description: 'Signup bonus'
      });
    }

    // Pre-fetch astrology data when profile has full birth details
    if (user.profile?.dob && user.profile?.timeOfBirth &&
        user.profile?.latitude != null && user.profile?.longitude != null) {
      astrologyService.refreshAstrologyData(user._id, user.profile)
        .then(() => console.log('[UserProfile] Astrology data prefetched on registration complete'))
        .catch(err => console.warn('[UserProfile] Astrology prefetch failed:', err.message));
    }

    // Generate JWT token
    const token = generateToken(user._id, 'user', user.clientId);

    res.json({
      success: true,
      message: 'Profile completed successfully. Registration complete!',
      data: {
        user: { ...user.toObject(), role: 'user' },
        token,
        registrationStep: 3,
        registrationComplete: true,
        emailVerified: user.emailVerified || false,
        mobileVerified: user.mobileVerified || false,
        profileCompleted: true,
        clientId: client.clientId,
        clientName: client.businessName
      }
    });
  } catch (error) {
    console.error('Step 3 registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to complete profile' 
    });
  }
});

/**
 * Upload Profile Image (direct upload from form-data)
 * POST /api/mobile/user/profile/image
 * Headers: Authorization: Bearer <token>
 * Content-Type: multipart/form-data
 * Fields: image (file)
 */
router.post('/profile/image', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User access required.',
      });
    }

    const imageFile = req.file;
    if (!imageFile) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required (field name: image)',
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user.registrationStep < 3) {
      return res.status(400).json({
        success: false,
        message: 'Please complete profile first before uploading image',
        data: {
          registrationStep: user.registrationStep,
        },
      });
    }

    // Delete old image if exists
    if (user.profileImage && !user.profileImage.startsWith('http')) {
      try {
        const { deleteFile } = await import('../../utils/storage.js');
        await deleteFile(user.profileImage);
      } catch (deleteErr) {
        console.error('Error deleting old profile image:', deleteErr);
      }
    }

    // Generate unique key and upload new image
    const fileExtension = imageFile.originalname.split('.').pop() || 'jpg';
    const imageKey = `images/user/${user._id}/profile/${uuidv4()}.${fileExtension}`;

    const { uploadBuffer } = await import('../../utils/storage.js');
    await uploadBuffer(imageFile.buffer, imageKey, imageFile.mimetype);

    // Save key in user profile
    user.profileImage = imageKey;
    await user.save();

    // Return presigned URL for immediate use
    let profileImageUrl = null;
    try {
      profileImageUrl = await getPresignedUrl(imageKey);
    } catch (urlErr) {
      console.error('Error generating presigned URL:', urlErr);
    }

    res.json({
      success: true,
      message: 'Profile image uploaded successfully',
      data: {
        user: {
          ...user.toObject(),
          role: 'user',
          profileImageUrl,
        },
      },
    });
  } catch (error) {
    console.error('Profile image upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload profile image',
    });
  }
});

/**
 * Check Email and Get Auth Token
 * POST /api/mobile/user/check-email
 * Body: { email, clientId }
 */
router.post('/check-email', async (req, res) => {
  try {
    const { email, clientId: clientCode } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is required' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    let user = await User.findOne({ clientId: client._id, email });
    
    if (!user) {
      // Create user and mark email as verified
      user = new User({
        email: email,
        emailVerified: true,
        password: 'temp_password_' + Date.now(),
        registrationStep: 1,
        mobileVerified: false,
        clientId: client._id,
        clientCode: client.clientId
      });
      await user.save();
      
      return res.json({
        success: false,
        message: 'not registered',
        data: {
          registered: false,
          email: email,
          emailVerified: true,
          registrationStep: 1,
          clientId: client.clientId
        }
      });
    }

    if (!user.emailVerified) {
      user.emailVerified = true;
      user.registrationStep = 1;
      await user.save();
    }

    if (user.registrationStep < 3) {
      return res.json({
        success: false,
        message: 'not registered',
        data: {
          registered: false,
          email: email,
          emailVerified: user.emailVerified,
          registrationStep: user.registrationStep,
          nextStep: user.registrationStep === 1 ? 'mobile_verification' : 'profile_completion',
          clientId: client.clientId
        }
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is inactive. Please contact administrator.' 
      });
    }

    const token = generateToken(user._id, 'user', user.clientId);

    res.json({
      success: true,
      message: 'User found',
      data: {
        registered: true,
        user: { ...user.toObject(), role: 'user' },
        token,
        emailVerified: user.emailVerified,
        clientId: client.clientId,
        clientName: client.businessName
      }
    });
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to check email' 
    });
  }
});

// ============================================
// LOGIN
// ============================================

/**
 * Send OTP to phone for login
 * POST /api/mobile/user/login/phone
 * Body: { mobile, otpMethod, clientId }
 */
router.post('/login/phone', async (req, res) => {
  try {
    const { mobile, otpMethod = 'whatsapp', clientId: clientCode } = req.body;

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    const client = await validateClientId(clientCode);

    const user = await User.findOne({ mobile, clientId: client._id, mobileVerified: true })
      .select('+mobileOtp +mobileOtpExpiry');

    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this mobile number' });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is inactive. Please contact administrator.' });
    }

    if (user.registrationStep < 3) {
      return res.status(400).json({ success: false, message: 'Registration incomplete. Please complete all steps.' });
    }

    const otp = generateOTP();
    const otpExpiry = getOTPExpiry();
    user.mobileOtp = otp;
    user.mobileOtpExpiry = otpExpiry;
    await user.save();

    await sendMobileOTP(mobile, otp, otpMethod);

    res.json({
      success: true,
      message: `OTP sent to ${mobile}`,
      data: { mobile }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to send OTP' });
  }
});

/**
 * Verify OTP and login
 * POST /api/mobile/user/login/phone/verify
 * Body: { mobile, otp, clientId }
 */
router.post('/login/phone/verify', async (req, res) => {
  try {
    const { mobile, otp, clientId: clientCode } = req.body;

    if (!mobile || !otp) {
      return res.status(400).json({ success: false, message: 'Mobile and OTP are required' });
    }

    const client = await validateClientId(clientCode);

    const user = await User.findOne({ mobile, clientId: client._id })
      .select('+mobileOtp +mobileOtpExpiry')
      .populate('clientId', 'clientId businessName');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const validation = validateOTP(user.mobileOtp, otp, user.mobileOtpExpiry);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    user.mobileOtp = undefined;
    user.mobileOtpExpiry = undefined;
    await user.save();

    const token = generateToken(user._id, 'user', user.clientId._id || user.clientId);

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
    res.status(500).json({ success: false, message: error.message || 'Login failed' });
  }
});

/**
 * User Login (Mobile) - Email + Password
 * POST /api/mobile/user/login
 * Body: { email, password, clientId (optional) }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password, clientId: clientCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    // Build query - if clientId provided, filter by it
    let query = { email };
    if (clientCode) {
      const client = await validateClientId(clientCode);
      query.clientId = client._id;
    }

    // Find user by email (and optionally by clientId)
    const user = await User.findOne(query)
      .select('+password')
      .populate('clientId', 'clientId businessName email');
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    if (user.registrationStep < 3) {
      return res.status(400).json({ 
        success: false, 
        message: 'Registration incomplete. Please complete all registration steps.',
        data: {
          registrationStep: user.registrationStep,
          emailVerified: user.emailVerified,
          mobileVerified: user.mobileVerified
        }
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

    // Generate token with user's clientId (ObjectId)
    const token = generateToken(user._id, 'user', user.clientId._id);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { 
          ...user.toObject(), 
          role: 'user',
          password: undefined // Remove password from response
        },
        token,
        clientId: user.clientId?.clientId || null,
        clientName: user.clientId?.businessName || null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Login failed' 
    });
  }
});

// ============================================
// PROFILE MANAGEMENT
// ============================================

/**
 * Get User Profile (Mobile)
 * GET /api/mobile/user/profile
 * Headers: Authorization: Bearer <token>
 */
router.get('/profile', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. User access required.' 
      });
    }

    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('clientId', 'clientId businessName email');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Backward compatibility: convert old stored S3 URLs into keys.
    await normalizeStoredProfileImageToKey(user);

    // Generate a fresh profile image URL if possible.
    let profileImageUrl = null;
    if (user.profileImage) {
      try {
        profileImageUrl = await resolveProfileImageUrl(user);
      } catch (error) {
        console.error('Error generating profile image URL:', error);
      }
    }

    const userData = user.toObject();
    if (profileImageUrl) {
      userData.profileImageUrl = profileImageUrl;
    } else if (isHttpUrl(user.profileImage) && !isS3Url(user.profileImage)) {
      // For external URLs (e.g., Google picture URL), pass through directly.
      userData.profileImageUrl = user.profileImage;
    }

    const token = generateToken(user._id, 'user', user.clientId);

    // Calculate benchmark data
    const karmaPoints = user.karmaPoints || 0;
    
    // Helper function to get benchmark tier
    const getBenchmarkTier = (points) => {
      if (points >= 25000) return { name: 'Platinum', icon: '💎', min: 25000, max: null };
      if (points >= 12000) return { name: 'Gold', icon: '🏆', min: 12000, max: 24999 };
      if (points >= 5000) return { name: 'Silver', icon: '🥈', min: 5000, max: 11999 };
      if (points >= 1000) return { name: 'Bronze', icon: '🥉', min: 1000, max: 4999 };
      return { name: 'Beginner', icon: '🌿', min: 0, max: 999 };
    };

    const currentTier = getBenchmarkTier(karmaPoints);
    const nextTier = currentTier.max ? getBenchmarkTier(currentTier.max + 1) : null;
    
    let progress = 100;
    let pointsToNext = 0;
    
    if (nextTier) {
      const range = currentTier.max - currentTier.min + 1;
      const earned = karmaPoints - currentTier.min;
      progress = Math.min(100, (earned / range) * 100);
      pointsToNext = nextTier.min - karmaPoints;
    }

    res.json({
      success: true,
      message: 'Profile retrieved successfully',
      data: {
        user: { ...userData, role: 'user' },
        token,
        benchmark: {
          current: currentTier,
          next: nextTier,
          progress: Math.round(progress * 10) / 10,
          pointsToNext: pointsToNext
        }
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to fetch profile' 
    });
  }
});

/**
 * Update User Profile (Mobile)
 * PUT /api/mobile/user/profile
 * Headers: Authorization: Bearer <token>
 * Body: { name, dob, timeOfBirth, placeOfBirth, latitude, longitude, gowthra, imageFileName, imageContentType }
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. User access required.' 
      });
    }

    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Update email if provided
    if (req.body.email) {
      user.email = req.body.email;
    }

    // Update password if provided
    if (req.body.password) {
      user.password = req.body.password;
    }

    // Update mobile if provided
    if (req.body.mobile) {
      user.mobile = req.body.mobile;
    }

    // Update profile fields if provided
    if (req.body.profile || req.body.name || req.body.dob || req.body.timeOfBirth || 
        req.body.placeOfBirth || req.body.latitude !== undefined || req.body.longitude !== undefined ||
        req.body.gowthra) {
      user.profile = {
        ...user.profile,
        ...(req.body.profile || {}),
        ...(req.body.name && { name: req.body.name }),
        ...(req.body.dob && { dob: new Date(req.body.dob) }),
        ...(req.body.timeOfBirth && { timeOfBirth: req.body.timeOfBirth }),
        ...(req.body.placeOfBirth && { placeOfBirth: req.body.placeOfBirth }),
        ...(req.body.latitude !== undefined && { latitude: parseFloat(req.body.latitude) }),
        ...(req.body.longitude !== undefined && { longitude: parseFloat(req.body.longitude) }),
        ...(req.body.gowthra && { gowthra: req.body.gowthra })
      };
    }

    // Handle image upload if provided
    let imageKey = null;
    let presignedUrl = null;

    if (req.body.imageFileName && req.body.imageContentType) {
      const fileExtension = req.body.imageFileName.split('.').pop();
      imageKey = `images/user/${user._id}/profile/${uuidv4()}.${fileExtension}`;
      
      presignedUrl = await generateUploadUrl(imageKey, req.body.imageContentType);
      
      user.profileImage = imageKey;
    }

    await user.save();
    await normalizeStoredProfileImageToKey(user);

    // Refresh astrology data when birth details are updated
    const birthFieldsUpdated = req.body.dob || req.body.timeOfBirth ||
      req.body.latitude !== undefined || req.body.longitude !== undefined ||
      (req.body.profile && (req.body.profile.dob || req.body.profile.timeOfBirth ||
        req.body.profile.latitude !== undefined || req.body.profile.longitude !== undefined));
    if (birthFieldsUpdated) {
      const userWithLoc = await User.findById(user._id).select('profile liveLocation').lean();
      const profileWithLocation = {
        ...userWithLoc?.profile,
        latitude: userWithLoc?.liveLocation?.latitude ?? userWithLoc?.profile?.latitude,
        longitude: userWithLoc?.liveLocation?.longitude ?? userWithLoc?.profile?.longitude
      };
      if (profileWithLocation.dob && profileWithLocation.timeOfBirth &&
          profileWithLocation.latitude != null && profileWithLocation.longitude != null) {
        astrologyService.refreshAstrologyData(user._id, profileWithLocation)
          .then(() => console.log('[UserProfile] Astrology data refreshed after profile update'))
          .catch(err => console.warn('[UserProfile] Astrology refresh failed:', err.message));
      }
    }

    const token = generateToken(user._id, 'user', user.clientId);

    let profileImageUrl = null;
    if (user.profileImage) {
      try {
        profileImageUrl = await resolveProfileImageUrl(user);
      } catch (error) {
        console.error('Error generating refreshed profile image URL:', error);
      }
    }

    const userData = user.toObject();
    if (profileImageUrl) {
      userData.profileImageUrl = profileImageUrl;
    }

    const response = {
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: { ...userData, role: 'user' },
        token
      }
    };

    if (presignedUrl) {
      response.data.imageUpload = {
        presignedUrl,
        key: imageKey
      };
    }

    res.json(response);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to update profile' 
    });
  }
});

/**
 * Register FCM device token for push notifications (no polling — server pushes via FCM).
 * PUT /api/mobile/user/push-token
 * Headers: Authorization: Bearer <user_token>
 * Body: { "fcmToken": "<FCM registration token>", "platform": "android" | "ios" | "web" }
 */
router.put('/push-token', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User access required.'
      });
    }

    const { fcmToken, platform } = req.body || {};
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim().length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Valid fcmToken is required'
      });
    }

    const plat = ['android', 'ios', 'web'].includes(platform) ? platform : 'unknown';
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const tokenStr = fcmToken.trim();
    const list = (user.fcmTokens || []).filter((t) => t.token !== tokenStr);
    list.unshift({ token: tokenStr, platform: plat, updatedAt: new Date() });
    user.fcmTokens = list.slice(0, 10);
    await user.save();

    res.json({
      success: true,
      message: 'Push token registered',
      data: { tokensStored: user.fcmTokens.length }
    });
  } catch (error) {
    console.error('Register push token error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to register push token'
    });
  }
});

/**
 * Remove FCM token (logout / uninstall).
 * DELETE /api/mobile/user/push-token
 * Body: { "fcmToken": "<token to remove>" }
 */
router.delete('/push-token', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User access required.'
      });
    }

    const { fcmToken } = req.body || {};
    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'fcmToken is required'
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.fcmTokens = (user.fcmTokens || []).filter((t) => t.token !== fcmToken.trim());
    await user.save();

    res.json({
      success: true,
      message: 'Push token removed',
      data: { tokensStored: user.fcmTokens.length }
    });
  } catch (error) {
    console.error('Remove push token error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to remove push token'
    });
  }
});

// ============================================
// RESEND OTP ENDPOINTS
// ============================================

/**
 * Resend Email OTP
 * POST /api/mobile/user/register/resend-email-otp
 * Body: { email, clientId }
 */
router.post('/register/resend-email-otp', async (req, res) => {
  try {
    const { email, clientId: clientCode } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is required' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    const user = await User.findOne({ 
      clientId: client._id, 
      email 
    }).select('+emailOtp +emailOtpExpiry');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found. Please start registration again.' 
      });
    }

   
    const otp = generateOTP();
    const otpExpiry = getOTPExpiry();

    user.emailOtp = otp;
    user.emailOtpExpiry = otpExpiry;
    await user.save();

    const emailResult = await sendEmailOTP(email, otp);
    if (!emailResult.success) {
      console.warn('Email OTP sending had issues, but continuing:', emailResult.message);
    }

    res.json({
      success: true,
      message: 'OTP resent to your email'
    });
  } catch (error) {
    console.error('Resend email OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to resend email OTP' 
    });
  }
});

/**
 * Resend Mobile OTP
 * POST /api/mobile/user/register/resend-mobile-otp
 * Body: { email, otpMethod, clientId }
 */
router.post('/register/resend-mobile-otp', async (req, res) => {
  try {
    const { email, otpMethod, clientId: clientCode } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is required' 
      });
    }

    if (!otpMethod || !['twilio', 'gupshup', 'whatsapp'].includes(otpMethod)) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP method is required (twilio, gupshup, or whatsapp)' 
      });
    }

    // Validate client
    const client = await validateClientId(clientCode);

    const user = await User.findOne({ 
      clientId: client._id, 
      email 
    }).select('+mobileOtp +mobileOtpExpiry');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found. Please start registration again.' 
      });
    }

    if (!user.mobile) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mobile number not provided. Please complete step 2 first.' 
      });
    }

    if (user.mobileVerified) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mobile already verified' 
      });
    }

    const otp = generateOTP();
    const otpExpiry = getOTPExpiry();

    user.mobileOtp = otp;
    user.mobileOtpExpiry = otpExpiry;
    user.mobileOtpMethod = otpMethod;
    await user.save();

    // Send OTP based on method
    let otpResult;
    if (otpMethod === 'whatsapp') {
      otpResult = await sendMobileOTP(user.mobile, otp, 'whatsapp');
    } else if (otpMethod === 'gupshup') {
      otpResult = await sendMobileOTP(user.mobile, otp, 'gupshup');
    } else {
      otpResult = await sendMobileOTP(user.mobile, otp, 'twilio');
    }
    
    if (!otpResult.success) {
      console.warn(`${otpMethod.toUpperCase()} OTP sending had issues, but continuing:`, otpResult.message);
    }

    res.json({
      success: true,
      message: `OTP resent to your mobile number via ${otpMethod.toUpperCase()}`
    });
  } catch (error) {
    console.error('Resend mobile OTP error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to resend mobile OTP' 
    });
  }
});
/**
 * Search Location using Google Places API
 * GET /api/mobile/user/search-location?q=mumbai
 */
router.get('/search-location', async (req, res) => {
  console.log('Search location endpoint hit');
  try {
    const { q } = req.query;

    if (!q || q.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 3 characters'
      });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('Google Places API key not configured');
    }

    // Use Google Geocoding API (no CORS issues from backend)
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error('Failed to fetch locations from Google');
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      return res.json({
        success: true,
        data: {
          locations: []
        }
      });
    }

    const locations = data.results.slice(0, 5).map(place => ({
      displayName: place.formatted_address,
      lat: place.geometry.location.lat,
      lon: place.geometry.location.lng
    }));

    res.json({
      success: true,
      data: {
        locations
      }
    });
  } catch (error) {
    console.error('Location search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search locations',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add this endpoint to your backend/src/routes/mobile/userProfile.js

/**
 * Reverse Geocode - Get location name from coordinates
 * GET /api/mobile/user/reverse-geocode?lat=19.0760&lon=72.8777
 */
router.get('/reverse-geocode', async (req, res) => {
  console.log('Reverse geocode endpoint hit');
  try {
    const { lat, lon } = req.query;

    // Validate inputs
    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required'
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    // Validate coordinate ranges
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude values'
      });
    }

    if (latitude < -90 || latitude > 90) {
      return res.status(400).json({
        success: false,
        message: 'Latitude must be between -90 and 90'
      });
    }

    if (longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        message: 'Longitude must be between -180 and 180'
      });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('Google Places API key not configured');
    }

    // Use Google Reverse Geocoding API
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error('Failed to fetch location from Google');
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      return res.json({
        success: true,
        data: {
          location: null,
          message: 'No location found for these coordinates'
        }
      });
    }

    // Get the most accurate result (usually the first one)
    const result = data.results[0];
    
    // Extract different components
    const addressComponents = result.address_components;
    let city = '';
    let state = '';
    let country = '';
    let postalCode = '';

    addressComponents.forEach(component => {
      if (component.types.includes('locality')) {
        city = component.long_name;
      }
      if (component.types.includes('administrative_area_level_1')) {
        state = component.long_name;
      }
      if (component.types.includes('country')) {
        country = component.long_name;
      }
      if (component.types.includes('postal_code')) {
        postalCode = component.long_name;
      }
    });

    res.json({
      success: true,
      data: {
        location: {
          formattedAddress: result.formatted_address,
          city: city,
          state: state,
          country: country,
          postalCode: postalCode,
          latitude: latitude,
          longitude: longitude,
          placeId: result.place_id
        }
      }
    });
  } catch (error) {
    console.error('Reverse geocode error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reverse geocode location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Updated /get-location endpoint to save live location in database
/**
 * Get Current Location (Mobile-friendly endpoint)
 * POST /api/mobile/user/get-location
 * Body: { latitude, longitude }
 * Headers: Authorization: Bearer <token>
 * 
 * This endpoint saves the user's live location in the database
 */
router.post('/get-location', authenticate, async (req, res) => {
  console.log('Get location endpoint hit');
  try {
    const { latitude, longitude } = req.body;

    // Validate inputs
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required in request body'
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    // Validate coordinate ranges
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude values'
      });
    }

    if (lat < -90 || lat > 90) {
      return res.status(400).json({
        success: false,
        message: 'Latitude must be between -90 and 90'
      });
    }

    if (lon < -180 || lon > 180) {
      return res.status(400).json({
        success: false,
        message: 'Longitude must be between -180 and 180'
      });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('Google Places API key not configured');
    }

    // Use Google Reverse Geocoding API
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error('Failed to fetch location from Google');
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      return res.json({
        success: true,
        data: {
          location: null,
          message: 'No location found for these coordinates'
        }
      });
    }

    // Get the most accurate result
    const result = data.results[0];
    
    // Extract address components
    const addressComponents = result.address_components;
    let city = '';
    let state = '';
    let country = '';
    let postalCode = '';
    let locality = '';
    let subLocality = '';

    addressComponents.forEach(component => {
      if (component.types.includes('locality')) {
        city = component.long_name;
      }
      if (component.types.includes('sublocality') || component.types.includes('sublocality_level_1')) {
        subLocality = component.long_name;
      }
      if (component.types.includes('administrative_area_level_2')) {
        locality = component.long_name;
      }
      if (component.types.includes('administrative_area_level_1')) {
        state = component.long_name;
      }
      if (component.types.includes('country')) {
        country = component.long_name;
      }
      if (component.types.includes('postal_code')) {
        postalCode = component.long_name;
      }
    });

    // Save live location to database
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update or create liveLocation
    user.liveLocation = {
      latitude: lat,
      longitude: lon,
      formattedAddress: result.formatted_address,
      city: city,
      state: state,
      country: country,
      lastUpdated: new Date()
    };

    await user.save();

    // Only refresh astrology when live location actually changes (not on every get-location call).
    // Use cached data if it exists and the coordinates haven't changed significantly.
    const userWithLoc = await User.findById(user._id).select('profile liveLocation').lean();
    const profileWithLocation = {
      ...userWithLoc?.profile,
      latitude: userWithLoc?.liveLocation?.latitude ?? userWithLoc?.profile?.latitude,
      longitude: userWithLoc?.liveLocation?.longitude ?? userWithLoc?.profile?.longitude
    };
    if (profileWithLocation.dob && profileWithLocation.timeOfBirth &&
        profileWithLocation.latitude != null && profileWithLocation.longitude != null) {
      // Use getCompleteAstrologyData with forceRefresh=false so cached DB data is returned
      // when available, avoiding repeated expensive API calls on every location ping.
      astrologyService.getCompleteAstrologyData(user._id, profileWithLocation, false)
        .then(() => console.log('[UserProfile] Astrology data ensured (cached or fresh) after get-location'))
        .catch(err => console.warn('[UserProfile] Astrology ensure failed:', err.message));
    }

    console.log(`Live location saved for user ${user._id}:`, {
      lat,
      lon,
      city,
      state,
      country
    });

    res.json({
      success: true,
      message: 'Location retrieved and saved successfully',
      data: {
        location: {
          formattedAddress: result.formatted_address,
          displayName: result.formatted_address,
          city: city,
          subLocality: subLocality,
          locality: locality,
          state: state,
          country: country,
          postalCode: postalCode,
          latitude: lat,
          longitude: lon,
          placeId: result.place_id,
          locationType: result.geometry.location_type,
          viewport: result.geometry.viewport
        },
        saved: true,
        savedAt: user.liveLocation.lastUpdated
      }
    });
  } catch (error) {
    console.error('Get location error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get location details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});



export default router;