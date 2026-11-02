// src/routes/public/dailyPrediction.js

import express from 'express';
import axios from 'axios';
import { authenticate } from '../../middleware/auth.js';
import User from '../../models/User.js';

const router = express.Router();

/**
 * Get daily nakshatra prediction using saved live location
 * POST /api/public/daily-prediction
 * Headers: Authorization: Bearer <token>
 * Body: {
 *   day: 10,
 *   month: 5,
 *   year: 1990,
 *   hour: 19,
 *   min: 55,
 *   tzone: 5.5
 * }
 * 
 * Note: lat and lon are now optional - will use saved live location if not provided
 */
router.post('/daily-prediction', authenticate, async (req, res) => {
  try {
    const { day, month, year, hour, min, tzone } = req.body;
    let { lat, lon } = req.body;

    // Validate required fields (lat/lon now optional)
    if (!day || !month || !year || !hour || min === undefined || !tzone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: {
          day: 'Day of birth (1-31)',
          month: 'Month of birth (1-12)',
          year: 'Year of birth',
          hour: 'Hour of birth (0-23)',
          min: 'Minute of birth (0-59)',
          tzone: 'Timezone (e.g., 5.5 for IST)',
          note: 'lat and lon are optional - will use saved live location if not provided'
        }
      });
    }

    // If lat/lon not provided, get from user's saved live location
    if (!lat || !lon) {
      const user = await User.findById(req.user._id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (!user.liveLocation || !user.liveLocation.latitude || !user.liveLocation.longitude) {
        return res.status(400).json({
          success: false,
          message: 'No saved location found. Please provide lat/lon or update your location using /api/mobile/user/get-location endpoint'
        });
      }

      lat = user.liveLocation.latitude;
      lon = user.liveLocation.longitude;

      console.log(`Using saved live location for user ${user._id}:`, {
        lat,
        lon,
        savedAt: user.liveLocation.lastUpdated
      });
    }

    // Validate numeric values
    const numericValidations = {
      day: { value: day, min: 1, max: 31 },
      month: { value: month, min: 1, max: 12 },
      year: { value: year, min: 1900, max: new Date().getFullYear() },
      hour: { value: hour, min: 0, max: 23 },
      min: { value: min, min: 0, max: 59 },
      lat: { value: lat, min: -90, max: 90 },
      lon: { value: lon, min: -180, max: 180 }
    };

    for (const [field, { value, min, max }] of Object.entries(numericValidations)) {
      const numValue = parseFloat(value);
      if (isNaN(numValue) || numValue < min || numValue > max) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${field}. Must be between ${min} and ${max}`
        });
      }
    }

    // Prepare data for astrology API
    const apiData = {
      day: parseInt(day),
      month: parseInt(month),
      year: parseInt(year),
      hour: parseInt(hour),
      min: parseInt(min),
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      tzone: parseFloat(tzone)
    };

    // Convert to URL-encoded format
    const urlEncodedData = Object.keys(apiData)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(apiData[key])}`)
      .join('&');

    console.log('[Daily Prediction API] Fetching daily nakshatra prediction...');

    // Call Astrology API
    const apiUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    const response = await axios.post(
      `${apiUrl}/daily_nakshatra_prediction`,
      urlEncodedData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-astrologyapi-key': process.env.ASTROLOGY_API_KEY
        },
        timeout: 30000
      }
    );

    console.log('[Daily Prediction API] Daily prediction fetched successfully');

    res.json({
      success: true,
      data: response.data,
      requestedFor: {
        date: `${day}/${month}/${year}`,
        time: `${hour}:${min}`,
        location: { lat, lon },
        timezone: tzone,
        locationSource: req.body.lat ? 'provided' : 'saved'
      }
    });

  } catch (error) {
    console.error('[Daily Prediction API] Daily prediction error:', error.message);
    
    if (error.response) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: 'Failed to fetch daily prediction from astrology service',
        error: process.env.NODE_ENV === 'development' ? error.response.data : undefined
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to fetch daily prediction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get daily prediction with date of birth (simplified input)
 * POST /api/public/daily-prediction/simple
 * Headers: Authorization: Bearer <token>
 * Body: {
 *   dob: "1990-05-10", (optional - will use user's profile dob if not provided)
 *   timeOfBirth: "19:55", (optional - will use user's profile timeOfBirth if not provided)
 *   timezone: 5.5 (optional, defaults to 5.5 IST)
 * }
 * 
 * Note: All fields are now optional - will use user's profile data and saved live location
 */
router.post('/daily-prediction/simple', authenticate, async (req, res) => {
  try {
    let { dob, timeOfBirth, latitude, longitude, timezone } = req.body;

    // Get user data
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Use user's profile data if not provided
    if (!dob && user.profile?.dob) {
      dob = user.profile.dob.toISOString().split('T')[0];
      console.log(`Using user's profile DOB: ${dob}`);
    }

    if (!timeOfBirth && user.profile?.timeOfBirth) {
      timeOfBirth = user.profile.timeOfBirth;
      console.log(`Using user's profile time of birth: ${timeOfBirth}`);
    }

    // Use user's saved live location if not provided
    if ((latitude === undefined || longitude === undefined)) {
      if (user.liveLocation?.latitude && user.liveLocation?.longitude) {
        latitude = user.liveLocation.latitude;
        longitude = user.liveLocation.longitude;
        console.log(`Using saved live location:`, {
          latitude,
          longitude,
          savedAt: user.liveLocation.lastUpdated
        });
      } else if (user.profile?.latitude && user.profile?.longitude) {
        // Fallback to profile location if no live location
        latitude = user.profile.latitude;
        longitude = user.profile.longitude;
        console.log(`Using profile location as fallback:`, { latitude, longitude });
      }
    }

    // Validate required fields after checking user data
    if (!dob || !timeOfBirth || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Missing required data. Please provide missing fields or update your profile.',
        missing: {
          dob: !dob ? 'Date of birth is required' : null,
          timeOfBirth: !timeOfBirth ? 'Time of birth is required' : null,
          location: (latitude === undefined || longitude === undefined) ? 
            'Location is required. Please update location using /api/mobile/user/get-location' : null
        }
      });
    }

    // Parse date of birth
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Use YYYY-MM-DD'
      });
    }

    // Parse time of birth
    const [hour, min] = timeOfBirth.split(':').map(Number);
    if (isNaN(hour) || isNaN(min) || hour < 0 || hour > 23 || min < 0 || min > 59) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    // Prepare data for astrology API
    const apiData = {
      day: birthDate.getDate(),
      month: birthDate.getMonth() + 1,
      year: birthDate.getFullYear(),
      hour: hour,
      min: min,
      lat: parseFloat(latitude),
      lon: parseFloat(longitude),
      tzone: timezone ? parseFloat(timezone) : 5.5
    };

    // Convert to URL-encoded format
    const urlEncodedData = Object.keys(apiData)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(apiData[key])}`)
      .join('&');

    console.log('[Daily Prediction Simple API] Fetching daily nakshatra prediction...');

    // Call Astrology API
    const apiUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    const response = await axios.post(
      `${apiUrl}/daily_nakshatra_prediction`,
      urlEncodedData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-astrologyapi-key': process.env.ASTROLOGY_API_KEY
        },
        timeout: 30000
      }
    );

    console.log('[Daily Prediction Simple API] Daily prediction fetched successfully');

    res.json({
      success: true,
      data: response.data,
      requestedFor: {
        dob,
        timeOfBirth,
        location: { latitude, longitude },
        timezone: apiData.tzone
      },
      dataSource: {
        dob: req.body.dob ? 'provided' : 'profile',
        timeOfBirth: req.body.timeOfBirth ? 'provided' : 'profile',
        location: (req.body.latitude !== undefined) ? 'provided' : 
                  (user.liveLocation?.latitude ? 'liveLocation' : 'profile')
      }
    });

  } catch (error) {
    console.error('[Daily Prediction Simple API] Daily prediction (simple) error:', error.message);
    
    if (error.response) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: 'Failed to fetch daily prediction from astrology service',
        error: process.env.NODE_ENV === 'development' ? error.response.data : undefined
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to fetch daily prediction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;