import express from 'express';
import authRoutes from './auth.js';
import partnerRoutes from './partner.js';
import adminRoutes from './admin.js';
import { clickRouter, trackRouter } from './track.js';
import { startImpactSync } from '../../services/referral/impactSync.js';

// Mounted at /api/referral
const router = express.Router();
router.use('/auth', authRoutes);
router.use('/partner', partnerRoutes);
router.use('/admin', adminRoutes);
router.use('/r', clickRouter);
router.use('/track', trackRouter);

startImpactSync();

export default router;
