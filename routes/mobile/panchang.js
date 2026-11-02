import express from 'express';
import { authenticate } from '../../middleware/auth.js';
import panchangService from '../../services/panchangService.js';
import User from '../../models/User.js';

const router = express.Router();

/**
 * GET /api/mobile/panchang
 * Get today's panchang data for the authenticated user
 * Headers: Authorization: Bearer <token>
 * Query: ?lat=19.07&lon=72.87&date=2026-11-02&tz=5.5&forceRefresh=false
 *   date - optional YYYY-MM-DD (default: today in `tz`); tz - optional hours from UTC (default 5.5)
 */
router.get('/', authenticate, async (req, res) => {
  try {
    if (req.decodedRole !== 'user' || !req.user) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const userId = req.user._id;

    // Get lat/lon from query params or user's live location or profile
    let latitude  = req.query.lat  ? parseFloat(req.query.lat)  : null;
    let longitude = req.query.lon  ? parseFloat(req.query.lon)  : null;
    const forceRefresh = req.query.forceRefresh === 'true';

    if ((req.query.lat && Number.isNaN(latitude)) || (req.query.lon && Number.isNaN(longitude))) {
      return res.status(400).json({ success: false, message: 'lat and lon must be valid numbers' });
    }

    // Timezone the date is interpreted in (hours from UTC). Invalid values are rejected, not silently ignored.
    let tzone = 5.5;
    if (req.query.tz !== undefined && req.query.tz !== '') {
      tzone = Number(req.query.tz);
      if (!Number.isFinite(tzone) || tzone < -12 || tzone > 14) {
        return res.status(400).json({ success: false, message: 'tz must be a number of hours from UTC between -12 and 14 (e.g. 5.5)' });
      }
    }

    // Requested calendar date; defaults to today in the user's timezone
    let currentDate = new Date();
    if (req.query.date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.query.date));
      const parsed = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getUTCMonth() !== +m[2] - 1) {
        return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD (e.g. 2026-11-02)' });
      }
      currentDate = parsed;
    }

    // Fallback to user's saved location if not provided
    if (latitude == null || longitude == null) {
      const user = await User.findById(userId)
        .select('liveLocation profile')
        .lean();

      latitude  = user?.liveLocation?.latitude  ?? user?.profile?.latitude  ?? null;
      longitude = user?.liveLocation?.longitude ?? user?.profile?.longitude ?? null;
    }

    if (latitude == null || longitude == null) {
      return res.status(400).json({
        success: false,
        message: 'Location is required. Please provide lat & lon query params or update your profile location.'
      });
    }

    // Get user profile for personalized nakshatra prediction
    const user = await User.findById(userId).select('profile').lean();
    const userProfile = user?.profile || null;

    const panchangData = await panchangService.getCompletePanchangData(
      userId,
      currentDate,
      latitude,
      longitude,
      forceRefresh,
      userProfile,
      { tzone }
    );

    res.json({
      success: true,
      data: panchangData
    });

  } catch (error) {
    console.error('[Panchang Route] Error:', error.message);
    res.status(500).json({
      success: false,
      message: `Failed to fetch panchang data: ${error.message}`
    });
  }
});

export default router;
