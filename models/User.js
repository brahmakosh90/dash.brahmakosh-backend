import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  authMethod: {
    type: String,
    enum: ['password', 'google', 'firebase', 'email'],
    default: 'password'
  },
  firebaseId: {
    type: String,
    sparse: true,
    unique: true
  },
  profile: {
    name: String,
    dob: Date,
    timeOfBirth: String,
    placeOfBirth: String,
    profession: String,
    latitude: {
      type: Number,
      min: -90,
      max: 90
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180
    },
    gowthra: String
  },
  // Live location (current/last known location)
  liveLocation: {
    latitude: {
      type: Number,
      min: -90,
      max: 90
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180
    },
    formattedAddress: String,
    city: String,
    state: String,
    country: String,
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  profileImage: String,
  mobile: {
    type: String,
    sparse: true
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  mobileVerified: {
    type: Boolean,
    default: false
  },
  emailOtp: {
    type: String,
    select: false
  },
  emailOtpExpiry: {
    type: Date,
    select: false
  },
  mobileOtp: {
    type: String,
    select: false
  },
  mobileOtpExpiry: {
    type: Date,
    select: false
  },
  mobileOtpMethod: {
    type: String,
    enum: ['sms', 'whatsapp', 'gupshup', 'twilio'],
    select: false
  },
  registrationStep: {
    type: Number,
    default: 0,
    min: 0,
    max: 3
  },
  loginApproved: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client'
  },
  passwordResetToken: {
    type: String,
    select: false
  },
  passwordResetExpires: {
    type: Date,
    select: false
  },
  // Current credit balance for paid features (chat, etc.)
  credits: {
    type: Number,
    default: 0,
    min: 0
  },
  // Karma points for spiritual activities and rewards
  karmaPoints: {
    type: Number,
    default: 0,
    min: 0
  },
  // User timezone for notifications
  timezone: {
    type: String,
    default: 'Asia/Kolkata' // Default to IST
  },
  // Firebase Cloud Messaging device tokens (push notifications)
  fcmTokens: [
    {
      token: { type: String, trim: true, required: true },
      platform: {
        type: String,
        enum: ['android', 'ios', 'web', 'unknown'],
        default: 'unknown'
      },
      updatedAt: { type: Date, default: Date.now }
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update timestamp
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw error;
  }
};

// Virtual field to calculate karma points breakdown
userSchema.virtual('karmaPointsBreakdown').get(async function() {
  // This will be populated by the API endpoint, not here
  return null;
});

// Remove sensitive data when converting to JSON
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailOtp;
  delete obj.emailOtpExpiry;
  delete obj.mobileOtp;
  delete obj.mobileOtpExpiry;
  delete obj.mobileOtpMethod;
  delete obj.fcmTokens;

  return obj;
};

const User = mongoose.model('User', userSchema);

export default User;