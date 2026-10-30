import express from 'express';
import multer from 'multer';
import User from '../../models/User.js';
import { getPresignedUrl, uploadBuffer } from '../../utils/storage.js';
import { v4 as uuidv4 } from 'uuid';
import { recordRegistration, resolveCode } from '../../services/referral/attribution.js';

const router = express.Router();

// Configure multer for memory storage (to handle file uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

/**
 * POST /api/mobile/user/register-with-image
 * Register user with profile image upload
 * Accepts multipart/form-data with image file
 */
router.post('/register-with-image', upload.single('image'), async (req, res) => {
  try {
    const { email, password, name, dob, timeOfBirth, placeOfBirth, gowthra, profession, referralCode } = req.body;
    const imageFile = req.file;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    let profileImageKey = null;

    // Upload image if provided
    if (imageFile) {
      try {
        const fileExtension = imageFile.originalname.split('.').pop() || 'jpg';
        const imageKey = `user-profiles/${uuidv4()}.${fileExtension}`;
        await uploadBuffer(imageFile.buffer, imageKey, imageFile.mimetype);
        profileImageKey = imageKey;
      } catch (uploadError) {
        console.error('Error uploading image:', uploadError);
        return res.status(500).json({
          success: false,
          message: 'Failed to upload image. Please try again.'
        });
      }
    }

    // Create user with profile data
    const user = new User({
      email: email.toLowerCase().trim(),
      password,
      profileImage: profileImageKey,
      profile: {
        name: name || '',
        dob: dob ? new Date(dob) : undefined,
        timeOfBirth: timeOfBirth || '',
        placeOfBirth: placeOfBirth || '',
        gowthra: gowthra || '',
        profession: profession || undefined,
      },
      credits: 1000, // signup bonus for mobile registration
      loginApproved: false, // Requires super admin approval
    });

    // Attach referral if code provided
    if (referralCode) {
      try {
        const { campaign, partner } = await resolveCode(referralCode);
        user.referredBy = { partnerId: partner._id, campaignId: campaign._id, code: referralCode.toUpperCase() };
      } catch (_) { /* invalid code — ignore, don't block registration */ }
    }

    await user.save();

    // Record referral attribution after save
    if (referralCode && user.referredBy?.partnerId) {
      try { await recordRegistration(user, { referralCode }); } catch (_) { /* non-blocking */ }
    }

    // Get presigned URL for the image if uploaded
    let profileImageUrl = null;
    if (profileImageKey) {
      try {
        profileImageUrl = await getPresignedUrl(profileImageKey);
      } catch (error) {
        console.error('Error generating presigned URL for profile image:', error);
        // Continue without image URL
      }
    }

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please wait for super admin approval to login.',
      data: {
        user: {
          ...user.toObject(),
          profileImageUrl: profileImageUrl,
        }
      }
    });
  } catch (error) {
    console.error('Error in register-with-image:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Registration failed. Please try again.'
    });
  }
});

export default router;

