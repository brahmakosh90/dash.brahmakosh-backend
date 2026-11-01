import express from 'express';
import mongoose from 'mongoose';
import Client from '../models/Client.js';
import User from '../models/User.js';
import AppSettings from '../models/AppSettings.js';
import { authenticate, authorize, generateToken } from '../middleware/auth.js';
import { listPrompts, updatePrompt, ensurePrompt } from '../services/promptService.js';

const router = express.Router();

// All routes require admin authentication
router.use(authenticate);
router.use(authorize('admin', 'super_admin'));

// Get all clients (super_admin: all; admin: those with matching adminId or unassigned)
router.get('/clients', async (req, res) => {
  try {
    const filter = req.user.role === 'super_admin'
      ? {}
      : { $or: [ { adminId: req.user._id }, { adminId: null }, { adminId: { $exists: false } } ] };
    const clients = await Client.find(filter)
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: { clients }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Create client
router.post('/clients', async (req, res) => {
  try {
    const { 
      email, 
      password, 
      businessName,
      websiteUrl,
      gstNumber,
      panNumber,
      businessLogo,
      fullName,
      mobileNumber,
      address,
      city,
      pincode
    } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    // Check if client already exists
    const existingClient = await Client.findOne({ email });
    if (existingClient) {
      return res.status(400).json({ 
        success: false, 
        message: 'Client already exists with this email' 
      });
    }

    // Create new client (clientId will be auto-generated)
    const client = new Client({
      email,
      password,
      businessName: businessName || '',
      websiteUrl: websiteUrl || '',
      gstNumber: gstNumber || '',
      panNumber: panNumber || '',
      businessLogo: businessLogo || '',
      fullName: fullName || '',
      mobileNumber: mobileNumber || '',
      address: address || '',
      city: city || '',
      pincode: pincode || '',
      createdBy: req.user._id,
      adminId: req.user._id,
      loginApproved: true, // Clients created by admin are auto-approved
      isActive: true
    });

    // Save client (this will trigger the pre-validate hook to generate clientId)
    await client.save();

    console.log('Client created successfully with ID:', client.clientId);

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { 
        client,
        clientId: client.clientId // Explicitly include the generated ID
      }
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get single client
router.get('/clients/:id', async (req, res) => {
  try {
    const filter = req.user.role === 'super_admin'
      ? { _id: req.params.id }
      : { _id: req.params.id, $or: [ { adminId: req.user._id }, { adminId: null }, { adminId: { $exists: false } } ] };
    const client = await Client.findOne(filter).select('-password');

    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: 'Client not found' 
      });
    }

    res.json({
      success: true,
      data: { client }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Update client
router.put('/clients/:id', async (req, res) => {
  try {
    const client = await Client.findOne({ 
      _id: req.params.id, 
      adminId: req.user.role === 'super_admin' ? { $exists: true } : req.user._id
    });

    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: 'Client not found' 
      });
    }

    // Prevent updating clientId
    const { clientId, ...updateData } = req.body;
    
    Object.assign(client, updateData);
    await client.save();

    res.json({
      success: true,
      message: 'Client updated successfully',
      data: { client }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Delete client (soft delete)
router.delete('/clients/:id', async (req, res) => {
  try {
    const client = await Client.findOne({ 
      _id: req.params.id, 
      adminId: req.user.role === 'super_admin' ? { $exists: true } : req.user._id
    });

    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: 'Client not found' 
      });
    }

    client.isActive = false;
    await client.save();

    res.json({
      success: true,
      message: 'Client deactivated successfully'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Activate client
router.patch('/clients/:id/activate', async (req, res) => {
  try {
    const client = await Client.findOne({ 
      _id: req.params.id, 
      adminId: req.user.role === 'super_admin' ? { $exists: true } : req.user._id
    });

    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: 'Client not found' 
      });
    }

    client.isActive = true;
    await client.save();

    res.json({
      success: true,
      message: 'Client activated successfully',
      data: { client }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get users under clients (admin credits view) with optional search + pagination
router.get('/users', async (req, res) => {
  try {
    const { search, page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const clients = await Client.find({ 
      adminId: req.user.role === 'super_admin' ? { $exists: true } : req.user._id
    }).select('_id');

    const clientIds = clients.map(c => c._id);

    const query = {
      clientId: { $in: clientIds }
    };

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { email: regex },
        { 'profile.name': regex }
      ];
    }
    
    const [users, total] = await Promise.all([
      User.find(query)
      .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
      .populate('clientId', 'email businessName clientId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
      User.countDocuments(query)
    ]);
    
    const usersWithKarma = users.map(user => ({
      ...user,
      karmaPoints: user.karmaPoints ?? 0
    }));
    
    res.json({
      success: true,
      data: { 
        users: usersWithKarma,
        total,
        page: pageNum,
        limit: pageSize,
        hasMore: total > skip + usersWithKarma.length
      }
    });
  } catch (error) {
    console.error('[Admin API] Error in GET /users:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get dashboard overview
router.get('/dashboard/overview', async (req, res) => {
  try {
    const clientQuery = req.user.role === 'super_admin'
      ? { adminId: { $exists: true } }
      : { adminId: req.user._id };

    const [totalClients, activeClients, allClients] = await Promise.all([
      Client.countDocuments(clientQuery),
      Client.countDocuments({ ...clientQuery, isActive: true }),
      Client.find(clientQuery).select('_id businessName email createdAt isActive').sort({ createdAt: -1 }).lean()
    ]);

    const clientIds = allClients.map(c => c._id);
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthlyGroup = { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } };
    const monthlySort = { $sort: { '_id.year': 1, '_id.month': 1 } };

    // All independent: run together instead of one after another
    const [
      totalUsers, activeUsers, userGrowthRaw, clientGrowthRaw, usersPerClient,
      newUsersThisMonth, newUsersLastMonth, newClientsThisMonth
    ] = await Promise.all([
      User.countDocuments({ clientId: { $in: clientIds } }),
      User.countDocuments({ clientId: { $in: clientIds }, isActive: true }),
      User.aggregate([{ $match: { clientId: { $in: clientIds }, createdAt: { $gte: sixMonthsAgo } } }, monthlyGroup, monthlySort]),
      Client.aggregate([{ $match: { ...clientQuery, createdAt: { $gte: sixMonthsAgo } } }, monthlyGroup, monthlySort]),
      User.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: { _id: '$clientId', userCount: { $sum: 1 } } },
        { $sort: { userCount: -1 } },
        { $limit: 5 }
      ]),
      User.countDocuments({ clientId: { $in: clientIds }, createdAt: { $gte: thisMonthStart } }),
      User.countDocuments({ clientId: { $in: clientIds }, createdAt: { $gte: lastMonthStart, $lt: thisMonthStart } }),
      Client.countDocuments({ ...clientQuery, createdAt: { $gte: thisMonthStart } })
    ]);

    // Fill missing months with 0
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fillMonths = (raw) => {
      const out = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const found = raw.find(r => r._id.year === d.getFullYear() && r._id.month === d.getMonth() + 1);
        out.push({ month: monthNames[d.getMonth()], count: found ? found.count : 0 });
      }
      return out;
    };
    const userGrowth = fillMonths(userGrowthRaw);
    const clientGrowth = fillMonths(clientGrowthRaw);

    const usersPerClientData = usersPerClient.map(u => {
      const c = allClients.find(cl => cl._id.toString() === u._id?.toString());
      return { clientName: c?.businessName || c?.email || 'Unknown', userCount: u.userCount };
    });

    // Recent clients (last 5)
    const recentClients = allClients.slice(0, 5).map(c => ({
      _id: c._id,
      businessName: c.businessName || c.email,
      email: c.email,
      isActive: c.isActive,
      createdAt: c.createdAt
    }));

    res.json({
      success: true,
      data: {
        totalClients,
        activeClients,
        totalUsers,
        activeUsers,
        newUsersThisMonth,
        newUsersLastMonth,
        newClientsThisMonth,
        userGrowth,
        clientGrowth,
        usersPerClient: usersPerClientData,
        recentClients
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Generate login token for client (admin impersonation)
router.post('/clients/:id/login-token', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    
    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: 'Client not found' 
      });
    }

    // Check if admin has permission (client belongs to this admin)
    if (req.user.role !== 'super_admin' && client.adminId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const token = generateToken(client._id, 'client');

    res.json({
      success: true,
      message: 'Login token generated successfully',
      data: {
        token,
        clientId: client._id,
        clientCode: client.clientId,
        businessName: client.businessName
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ============ Prompt management ============

router.get('/prompts', async (req, res) => {
  try {
    const prompts = await listPrompts();
    res.json({
      success: true,
      data: { prompts }
    });
  } catch (error) {
    console.error('[Admin API] Error fetching prompts:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load prompts'
    });
  }
});

router.put('/prompts/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { label, description, content } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Prompt content is required'
      });
    }

    await ensurePrompt(key);

    const updates = {
      content: content.trim()
    };

    if (typeof label === 'string' && label.trim()) {
      updates.label = label.trim();
    }

    if (typeof description === 'string') {
      updates.description = description.trim();
    }

    const prompt = await updatePrompt(key, updates);

    res.json({
      success: true,
      message: 'Prompt updated successfully',
      data: { prompt }
    });
  } catch (error) {
    console.error('[Admin API] Error updating prompt:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update prompt'
    });
  }
});

// ============ App Settings (e.g. Gemini API Key) ============

// @route   GET /api/admin/settings/gemini-api-key
// @desc    Get Gemini API key status (masked). Optional query: clientId (Client _id or clientId code). Admin/Super Admin only.
router.get('/settings/gemini-api-key', async (req, res) => {
  try {
    const { clientId } = req.query;
    let key = null;
    let scope = 'app';

    if (clientId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(clientId) && String(clientId).length === 24;
      const client = isObjectId
        ? await Client.findById(clientId).select('clientId businessName fullName settings.geminiApiKey').lean()
        : await Client.findOne({ clientId: String(clientId) }).select('clientId businessName fullName settings.geminiApiKey').lean();
      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }
      key = client.settings?.geminiApiKey || null;
      scope = 'client';
      const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
      return res.json({
        success: true,
        data: {
          configured: !!key,
          masked,
          scope,
          client: { _id: client._id, clientId: client.clientId, businessName: client.businessName, fullName: client.fullName }
        }
      });
    }

    const settings = await AppSettings.getSettings();
    key = settings?.geminiApiKey;
    const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
    res.json({
      success: true,
      data: {
        configured: !!key,
        masked,
        scope
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PUT /api/admin/settings/gemini-api-key
// @desc    Update Gemini API key. Body: { apiKey, clientId? }. If clientId provided, update that client's key; else app-level. Admin/Super Admin only.
router.put('/settings/gemini-api-key', async (req, res) => {
  try {
    const { apiKey, clientId } = req.body;
    const value = apiKey != null ? String(apiKey).trim() || null : null;

    if (clientId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(clientId) && String(clientId).length === 24;
      const client = isObjectId
        ? await Client.findById(clientId)
        : await Client.findOne({ clientId: String(clientId) });
      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }
      if (!client.settings) client.settings = {};
      client.settings.geminiApiKey = value;
      await client.save();
      const key = client.settings.geminiApiKey;
      const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
      return res.json({
        success: true,
        message: 'Gemini API key updated for client',
        data: {
          configured: !!key,
          masked,
          scope: 'client',
          client: { _id: client._id, clientId: client.clientId, businessName: client.businessName, fullName: client.fullName }
        }
      });
    }

    const settings = await AppSettings.getSettings();
    settings.geminiApiKey = value;
    await settings.save();
    const key = settings.geminiApiKey;
    const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
    res.json({
      success: true,
      message: 'Gemini API key updated',
      data: { configured: !!key, masked, scope: 'app' }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ App Settings (OpenAI API Key) ============

// @route   GET /api/admin/settings/openai-api-key
// @desc    Get OpenAI API key status (masked). Optional query: clientId (Client _id or clientId code). Admin/Super Admin only.
router.get('/settings/openai-api-key', async (req, res) => {
  try {
    const { clientId } = req.query;
    let key = null;
    let scope = 'app';

    if (clientId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(clientId) && String(clientId).length === 24;
      const client = isObjectId
        ? await Client.findById(clientId).select('clientId businessName fullName settings.openaiApiKey').lean()
        : await Client.findOne({ clientId: String(clientId) }).select('clientId businessName fullName settings.openaiApiKey').lean();
      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }
      key = client.settings?.openaiApiKey || null;
      scope = 'client';
      const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
      return res.json({
        success: true,
        data: {
          configured: !!key,
          masked,
          scope,
          client: { _id: client._id, clientId: client.clientId, businessName: client.businessName, fullName: client.fullName }
        }
      });
    }

    const settings = await AppSettings.getSettings();
    key = settings?.openaiApiKey;
    const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
    res.json({
      success: true,
      data: {
        configured: !!key,
        masked,
        scope
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PUT /api/admin/settings/openai-api-key
// @desc    Update OpenAI API key. Body: { apiKey, clientId? }. If clientId provided, update that client's key; else app-level. Admin/Super Admin only.
router.put('/settings/openai-api-key', async (req, res) => {
  try {
    const { apiKey, clientId } = req.body;
    const value = apiKey != null ? String(apiKey).trim() || null : null;

    if (clientId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(clientId) && String(clientId).length === 24;
      const client = isObjectId
        ? await Client.findById(clientId)
        : await Client.findOne({ clientId: String(clientId) });
      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }
      if (!client.settings) client.settings = {};
      client.settings.openaiApiKey = value;
      await client.save();
      const key = client.settings.openaiApiKey;
      const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
      return res.json({
        success: true,
        message: 'OpenAI API key updated for client',
        data: {
          configured: !!key,
          masked,
          scope: 'client',
          client: { _id: client._id, clientId: client.clientId, businessName: client.businessName, fullName: client.fullName }
        }
      });
    }

    const settings = await AppSettings.getSettings();
    settings.openaiApiKey = value;
    await settings.save();
    const key = settings.openaiApiKey;
    const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : null;
    res.json({
      success: true,
      message: 'OpenAI API key updated',
      data: { configured: !!key, masked, scope: 'app' }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ System Health ============

// @route   GET /api/admin/health
// @desc    Real-time system health: DB status, memory, uptime, counts
router.get('/health', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const dbStatusMap = { 0: 'Disconnected', 1: 'Connected', 2: 'Connecting', 3: 'Disconnecting' };
    const dbStatus = dbStatusMap[dbState] || 'Unknown';

    const mem = process.memoryUsage();
    const toMB = (bytes) => Math.round(bytes / 1024 / 1024);

    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptime = `${hours}h ${minutes}m ${seconds}s`;

    const clientQuery = req.user.role === 'super_admin'
      ? { adminId: { $exists: true } }
      : { adminId: req.user._id };

    const allClients = await Client.find(clientQuery).select('_id').lean();
    const clientIds = allClients.map(c => c._id);

    const [totalClients, activeClients, totalUsers, activeUsers] = await Promise.all([
      Client.countDocuments(clientQuery),
      Client.countDocuments({ ...clientQuery, isActive: true }),
      User.countDocuments({ clientId: { $in: clientIds } }),
      User.countDocuments({ clientId: { $in: clientIds }, isActive: true })
    ]);

    const services = [
      { name: 'MongoDB', status: dbState === 1 ? 'Operational' : 'Down', healthy: dbState === 1 },
      { name: 'REST API', status: 'Operational', healthy: true },
      { name: 'Authentication', status: 'Operational', healthy: true },
      { name: 'File Storage', status: 'Operational', healthy: true }
    ];

    res.json({
      success: true,
      data: {
        server: { status: 'Operational', uptime, nodeVersion: process.version, env: process.env.NODE_ENV || 'production' },
        database: { status: dbStatus, healthy: dbState === 1, host: mongoose.connection.host || 'Atlas' },
        memory: { heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal), rss: toMB(mem.rss), unit: 'MB' },
        services,
        stats: { totalClients, activeClients, totalUsers, activeUsers }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ API Health Monitor ============

// @route   GET /api/admin/api-health
// @desc    Ping all important API endpoints and return status + response time
router.get('/api-health', async (req, res) => {
  const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
  const token = req.headers.authorization; // forward admin token

  const endpoints = [
    // ── Admin APIs ──
    { name: 'Admin Dashboard',           group: 'Admin',    method: 'GET', url: `${BASE}/admin/dashboard/overview` },
    { name: 'Admin Clients',             group: 'Admin',    method: 'GET', url: `${BASE}/admin/clients` },
    { name: 'Admin Users',               group: 'Admin',    method: 'GET', url: `${BASE}/admin/users?limit=1` },
    { name: 'Admin Prompts',             group: 'Admin',    method: 'GET', url: `${BASE}/admin/prompts` },
    { name: 'Admin Health',              group: 'Admin',    method: 'GET', url: `${BASE}/admin/health` },
    { name: 'Auth - Admin Me',           group: 'Admin',    method: 'GET', url: `${BASE}/auth/admin/me` },
    { name: 'Health Check',              group: 'Admin',    method: 'GET', url: `${BASE}/health` },

    // ── Partner APIs ──
    { name: 'Partner Profile',           group: 'Partner',  method: 'GET', url: `${BASE}/mobile/partner/profile` },

    // ── Partner Chat APIs ──
    { name: 'Chat - Partner Status GET', group: 'Partner',  method: 'GET',   url: `${BASE}/chat/partner/status` },
    { name: 'Chat - Partner Requests',   group: 'Partner',  method: 'GET',   url: `${BASE}/chat/partner/requests` },
    { name: 'Chat - Available Partners', group: 'Partner',  method: 'GET',   url: `${BASE}/chat/partners` },
    { name: 'Chat - Conversations',      group: 'Partner',  method: 'GET',   url: `${BASE}/chat/conversations` },
    { name: 'Chat - Unread Count',       group: 'Partner',  method: 'GET',   url: `${BASE}/chat/unread-count` },
    { name: 'Chat - Credits History (User)',    group: 'Partner', method: 'GET', url: `${BASE}/chat/credits/history/user` },
    { name: 'Chat - Credits History (Partner)', group: 'Partner', method: 'GET', url: `${BASE}/chat/credits/history/partner` },
    { name: 'Chat - Voice Call History (User)',    group: 'Partner', method: 'GET', url: `${BASE}/chat/voice/calls/history/user` },
    { name: 'Chat - Voice Call History (Partner)', group: 'Partner', method: 'GET', url: `${BASE}/chat/voice/calls/history/partner` },

    // ── Spiritual Check-in APIs ──
    { name: 'Spiritual Check-in',        group: 'Spiritual', method: 'GET', url: `${BASE}/mobile/spiritual-checkin` },
    { name: 'Spiritual Activities',      group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-activities` },
    { name: 'Spiritual Rewards',         group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-rewards` },
    { name: 'Spiritual Stats',           group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-stats` },
    { name: 'Spiritual Clips',           group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-clips` },
    { name: 'Spiritual Configurations',  group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-configurations` },
    { name: 'Karma Points',              group: 'Spiritual', method: 'GET', url: `${BASE}/karma-points` },
    { name: 'Reward Redemptions',        group: 'Spiritual', method: 'GET', url: `${BASE}/reward-redemptions` },
    { name: 'Leaderboard',               group: 'Spiritual', method: 'GET', url: `${BASE}/leaderboard` },
    { name: 'Sankalp',                   group: 'Spiritual', method: 'GET', url: `${BASE}/sankalp` },
    { name: 'User Sankalp',              group: 'Spiritual', method: 'GET', url: `${BASE}/user-sankalp` },
    { name: 'Puja Padhati',              group: 'Spiritual', method: 'GET', url: `${BASE}/puja-padhati` },
    { name: 'Swapna Decoder',            group: 'Spiritual', method: 'GET', url: `${BASE}/swapna-decoder` },

    // ── Content APIs ──
    { name: 'Testimonials',              group: 'Content',  method: 'GET', url: `${BASE}/testimonials` },
    { name: 'Experts',                   group: 'Content',  method: 'GET', url: `${BASE}/experts` },
    { name: 'Expert Categories',         group: 'Content',  method: 'GET', url: `${BASE}/expert-categories` },
    { name: 'Meditations',               group: 'Content',  method: 'GET', url: `${BASE}/meditations` },
    { name: 'Chantings',                 group: 'Content',  method: 'GET', url: `${BASE}/chantings` },
    { name: 'Brahm Avatars',             group: 'Content',  method: 'GET', url: `${BASE}/brahm-avatars` },
    { name: 'Live Avatars',              group: 'Content',  method: 'GET', url: `${BASE}/live-avatars` },
    { name: 'Chapters',                  group: 'Content',  method: 'GET', url: `${BASE}/chapters` },
    { name: 'Reviews',                   group: 'Content',  method: 'GET', url: `${BASE}/reviews` },
    { name: 'Sponsors',                  group: 'Content',  method: 'GET', url: `${BASE}/sponsors` },
    { name: 'Brand Assets',              group: 'Content',  method: 'GET', url: `${BASE}/brand-assets` },
    { name: 'Founder Messages',          group: 'Content',  method: 'GET', url: `${BASE}/founder-messages` },
    { name: 'Notifications',             group: 'Content',  method: 'GET', url: `${BASE}/notifications` },
    { name: 'Voice Config',              group: 'Content',  method: 'GET', url: `${BASE}/voice-config` },
    { name: 'Prathanas',                 group: 'Content',  method: 'GET', url: `${BASE}/prathanas` },
    { name: 'Shlokas',                   group: 'Content',  method: 'GET', url: `${BASE}/shlokas` },
  ];

  // Probes run a few at a time. Firing all ~45 at once made the server queue behind its own probes, so every
  // endpoint (even 401s that do no work) read 500ms+ and the numbers said nothing about real latency.
  // Only GET is probed: the old POST/PUT/PATCH probes hit register/login/OTP/status routes with the admin's token.
  const PROBE_CONCURRENCY = 4;
  const results = new Array(endpoints.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < endpoints.length) {
      const idx = cursor++;
      const ep = endpoints[idx];
      results[idx] = await (async () => {
      const start = Date.now();
      try {
        const response = await fetch(ep.url, {
          method: ep.method,
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000)
        });
        const ms = Date.now() - start;
        // 401/403 = auth protected but reachable = OK for existence check
        const reachable = response.status < 500;
        return {
          name: ep.name,
          url: ep.url.replace(BASE, '/api'),
          method: ep.method,
          status: response.status,
          ms,
          healthy: reachable,
          label: reachable ? (ms < 300 ? 'Fast' : ms < 1000 ? 'Slow' : 'Very Slow') : 'Error'
        };
      } catch (err) {
        return {
          name: ep.name,
          url: ep.url.replace(BASE, '/api'),
          method: ep.method,
          status: 0,
          ms: Date.now() - start,
          healthy: false,
          label: 'Unreachable',
          error: err.message
        };
      }
      })();
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

  const totalHealthy = results.filter(r => r.healthy).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);

  res.json({
    success: true,
    data: {
      summary: { total: results.length, healthy: totalHealthy, failed: results.length - totalHealthy, avgMs },
      endpoints: results
    }
  });
});

// ============ App Settings (Stripe Credits per Unit) ============

// @route   GET /api/admin/settings/stripe-credits
// @desc    Get current credits per currency unit (e.g. 1 INR = X credits)
router.get('/settings/stripe-credits', async (req, res) => {
  try {
    const settings = await AppSettings.getSettings();
    res.json({
      success: true,
      data: {
        creditsPerUnit: typeof settings.stripeCreditsPerUnit === 'number'
          ? settings.stripeCreditsPerUnit
          : 2
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PUT /api/admin/settings/stripe-credits
// @desc    Update how many credits 1 currency unit gives. Body: { creditsPerUnit }
router.put('/settings/stripe-credits', async (req, res) => {
  try {
    const { creditsPerUnit } = req.body || {};
    const value = Number(creditsPerUnit);
    if (!value || isNaN(value) || value <= 0) {
      return res.status(400).json({
        success: false,
        message: 'creditsPerUnit must be a positive number'
      });
    }

    const settings = await AppSettings.getSettings();
    settings.stripeCreditsPerUnit = value;
    await settings.save();

    res.json({
      success: true,
      message: 'Stripe credits-per-unit updated',
      data: {
        creditsPerUnit: settings.stripeCreditsPerUnit
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;