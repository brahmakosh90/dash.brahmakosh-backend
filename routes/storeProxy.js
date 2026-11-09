import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = express.Router();

const STORE_BASE_URL = process.env.STORE_BASE_URL || 'https://store.brahmakosh.com';
const SHOP_BASE_URL  = process.env.SHOP_BASE_URL  || 'https://shop.brahmakosh.com';
import { JWT_SECRET } from '../middleware/auth.js';

// Cache store-native tokens by userId to avoid calling token-by-email on every request.
const storeTokenCache = new Map(); // userId -> { token, expMs }

const forward = async (req, res, method, storePath, options = {}) => {
  try {
    const url = `${STORE_BASE_URL}${storePath}`;

    const headers = {
      'Content-Type': 'application/json',
    };

    // If shop is using cookie-based auth, convert cookie -> Authorization header
    // so upstream store endpoints work without needing front-end JS access to tokens.
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    if (cookieHeader) {
      for (const part of String(cookieHeader).split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (!k) continue;
        cookies[k] = rest.join('=');
      }
    }
    const cookieToken = cookies.auth_token || cookies.token || null;

    const mintStoreTokenFromCookie = async (cookieJwt) => {
      // If the browser hits this proxy with the SSO cookie, cookieJwt belongs to our backend.
      // BrahmBazar/Store might use its own JWT_SECRET, so we create a store-native token by email.
      try {
        const decoded = jwt.verify(cookieJwt, JWT_SECRET);
        const userId = decoded?.userId || decoded?.id;
        const role = decoded?.role;
        if (!userId || role !== 'user') return null;

        const nowMs = Date.now();
        const cached = storeTokenCache.get(String(userId));
        if (cached?.token && (!cached.expMs || cached.expMs > nowMs)) {
          return cached.token;
        }

        const user = await User.findById(userId).select('email');
        if (!user?.email) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[StoreProxy][SSO] User email not found in local DB for userId:', userId);
          }
          return null;
        }

        // Call store "token-by-email" to get a JWT that store will accept.
        try {
          const tokenRes = await axios.post(`${STORE_BASE_URL}/api/users/token-by-email`, { email: user.email });
          const storeToken = tokenRes?.data?.token;
          if (!storeToken) return null;

          const expMs = decoded?.exp ? decoded.exp * 1000 : null;
          storeTokenCache.set(String(userId), { token: storeToken, expMs });
          return storeToken || null;
        } catch (e) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[StoreProxy][SSO] token-by-email failed for email:', user.email, 'status:', e?.response?.status);
          }
          return null;
        }
      } catch (e) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[StoreProxy][SSO] mintStoreTokenFromCookie jwt verify failed:', e?.message);
        }
        return null;
      }
    };

    // Forward Authorization header if present (Bearer token from /token-by-email or login)
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    } else if (cookieToken) {
      // Prefer store-native token to avoid JWT_SECRET/payload mismatch.
      const storeToken = await mintStoreTokenFromCookie(cookieToken);
      if (storeToken) {
        headers.Authorization = `Bearer ${storeToken}`;
      } else {
        // Fallback: forward original token (best effort).
        headers.Authorization = `Bearer ${cookieToken}`;
      }
    }

    const config = {
      method,
      url,
      headers,
      params: options.params || undefined,
      data: options.body !== undefined ? options.body : req.body,
      timeout: Number(process.env.STORE_PROXY_TIMEOUT_MS || 10000),
    };

    const response = await axios(config);
    return res.status(response.status || 200).json(response.data);
  } catch (err) {
    // Ensure we return a response even on network timeouts.
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        success: false,
        message: 'Store request timed out',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
    console.error('[StoreProxy] Error forwarding request:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to contact store API',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

// ---------------------------------------------------------------------------
// SSO: App → Web (shop.brahmakosh.com)
// GET /api/store/sso-login?token=JWT[&redirect=/]
//
// Flow:
// 1) Flutter gets JWT (already logged-in user in app)
// 2) Flutter opens WebView: https://prod.brahmakosh.com/api/store/sso-login?token=JWT
// 3) This route verifies JWT, sets secure HTTP-only cookie for *.brahmakosh.com
// 4) Redirects to SHOP_BASE_URL (without token in URL)
// ---------------------------------------------------------------------------
router.get('/sso-login', async (req, res) => {
  try {
    const token =
      req.query.token ||
      (req.headers.authorization && req.headers.authorization.split(' ')[1]);

    if (!token) {
      return res.status(400).send('Missing token');
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).send('Invalid token');
    }

    // Optional: you can add extra checks here (role, isActive, etc.) using decoded

    // Cross-subdomain + WebView: Domain=.brahmakosh.com, SameSite=None, Secure, HttpOnly
    // (Flutter SSO doc). SameSite=None is required so cookies attach to shop→prod API calls in embedded WebViews.
    const cookieDomain = process.env.SSO_COOKIE_DOMAIN || '.brahmakosh.com';
    const sameSiteRaw = (process.env.SSO_COOKIE_SAMESITE || 'none').toLowerCase();
    const sameSite = ['lax', 'strict', 'none'].includes(sameSiteRaw) ? sameSiteRaw : 'none';
    let secure = process.env.SSO_COOKIE_SECURE !== 'false';
    if (sameSite === 'none') secure = true; // browsers reject SameSite=None without Secure

    // Align cookie lifetime with JWT exp (if present)
    let maxAge = undefined;
    if (decoded?.exp) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const deltaSeconds = decoded.exp - nowSeconds;
      if (deltaSeconds > 0) maxAge = deltaSeconds * 1000; // ms
    }

    const cookieOpts = {
      httpOnly: true,
      secure,
      sameSite,
      domain: cookieDomain,
      path: '/',
      ...(maxAge ? { maxAge } : {}),
    };

    res.cookie('auth_token', token, cookieOpts);

    // Some shop implementations may look for a different cookie name.
    res.cookie('token', token, cookieOpts);

    // Clean redirect without token in URL
    const redirectInput = (req.query.redirect && String(req.query.redirect)) || '/';

    // Normalize relative path and apply known route mappings for shop.
    // Example: docs may use `/remedies`, but shop route is `/category/remedies`.
    let mappedPath = redirectInput;
    let search = '';
    try {
      const u = new URL(redirectInput, SHOP_BASE_URL);
      mappedPath = u.pathname;
      search = u.search || '';
    } catch (_) {
      // Keep mappedPath as-is
    }

    if (mappedPath === '/remedies' || mappedPath === '/remedies/') {
      mappedPath = '/category/remedies';
    }

    const targetUrl = `${SHOP_BASE_URL.replace(/\/$/, '')}${mappedPath}${search}`;

    return res.redirect(targetUrl);
  } catch (err) {
    console.error('[StoreProxy] SSO error:', err.message);
    return res.status(500).send('SSO failed');
  }
});

// 1. Auth & User Management ----------------------------------------------------

// Register user -> POST /api/store/users/register
router.post('/users/register', async (req, res) => {
  await forward(req, res, 'post', '/api/users/register');
});

// Login user -> POST /api/store/users/login
router.post('/users/login', async (req, res) => {
  await forward(req, res, 'post', '/api/users/login');
});

// Get user profile (requires Authorization header) -> GET /api/store/users/profile
router.get('/users/profile', async (req, res) => {
  await forward(req, res, 'get', '/api/users/profile');
});

// 2. Products ------------------------------------------------------------------

// Categories -> GET /api/store/categories
router.get('/categories', async (req, res) => {
  await forward(req, res, 'get', '/api/categories');
});

// Categories admin -> GET /api/store/categories/admin
router.get('/categories/admin', async (req, res) => {
  await forward(req, res, 'get', '/api/categories/admin');
});

// Get products -> GET /api/store/products?keyword=&category=&subcategory=
router.get('/products', async (req, res) => {
  const params = {
    keyword: req.query.keyword,
    category: req.query.category,
    subcategory: req.query.subcategory,
  };
  await forward(req, res, 'get', '/api/products', { params });
});

// Get highlighted products -> GET /api/store/products/highlighted
router.get('/products/highlighted', async (req, res) => {
  await forward(req, res, 'get', '/api/products/highlighted');
});

// Get trending products -> GET /api/store/products/trending
router.get('/products/trending', async (req, res) => {
  await forward(req, res, 'get', '/api/products/trending');
});

// Get new arrivals products -> GET /api/store/products/new-arrival
router.get('/products/new-arrival', async (req, res) => {
  await forward(req, res, 'get', '/api/products/new-arrival');
});

// Get single product -> GET /api/store/products/:id
router.get('/products/:id', async (req, res) => {
  await forward(req, res, 'get', `/api/products/${req.params.id}`);
});

// Create product (admin only) – JSON proxy (does not handle files)
router.post('/products', async (req, res) => {
  await forward(req, res, 'post', '/api/products');
});

// 3. Cart & Checkout ----------------------------------------------------------

// Update cart -> POST /api/store/cart
router.post('/cart', async (req, res) => {
  await forward(req, res, 'post', '/api/cart');
});

// Get cart -> GET /api/store/cart
router.get('/cart', async (req, res) => {
  await forward(req, res, 'get', '/api/cart');
});

// Update cart item qty -> PUT /api/store/cart/:itemId
router.put('/cart/:itemId', async (req, res) => {
  await forward(req, res, 'put', `/api/cart/${req.params.itemId}`);
});

// Remove cart item -> DELETE /api/store/cart/:itemId
router.delete('/cart/:itemId', async (req, res) => {
  await forward(req, res, 'delete', `/api/cart/${req.params.itemId}`);
});

// Process checkout -> POST /api/store/checkout
router.post('/checkout', async (req, res) => {
  await forward(req, res, 'post', '/api/checkout');
});

// 4. Payment -------------------------------------------------------------------

// Create payment session -> POST /api/store/payment/create-checkout-session
router.post('/payment/create-checkout-session', async (req, res) => {
  await forward(req, res, 'post', '/api/payment/create-checkout-session');
});

// Verify payment -> POST /api/store/payment/verify
router.post('/payment/verify', async (req, res) => {
  await forward(req, res, 'post', '/api/payment/verify');
});

// 4.2 Coupons ------------------------------------------------------------------
// Apply coupon -> POST /api/store/coupons/apply
router.post('/coupons/apply', async (req, res) => {
  await forward(req, res, 'post', '/api/coupons/apply');
});

// 5. Addresses -----------------------------------------------------------------

// Add address -> POST /api/store/user/address/add
router.post('/user/address/add', async (req, res) => {
  await forward(req, res, 'post', '/api/user/address/add');
});

// List addresses -> GET /api/store/user/address/list
router.get('/user/address/list', async (req, res) => {
  await forward(req, res, 'get', '/api/user/address/list');
});

// 6. Dynamic Content (CMS) -----------------------------------------------------

// Get content -> GET /api/store/content?section=navbar
router.get('/content', async (req, res) => {
  const params = { section: req.query.section };
  await forward(req, res, 'get', '/api/content', { params });
});

// Banners -> GET /api/store/banners
router.get('/banners', async (req, res) => {
  await forward(req, res, 'get', '/api/banners');
});

// Active coupons -> GET /api/store/coupons/active
router.get('/coupons/active', async (req, res) => {
  await forward(req, res, 'get', '/api/coupons/active');
});

// Wishlist ----------------------------------------------------------------------
router.get('/users/wishlist', async (req, res) => {
  await forward(req, res, 'get', '/api/users/wishlist');
});

router.post('/users/wishlist', async (req, res) => {
  await forward(req, res, 'post', '/api/users/wishlist');
});

export default router;

