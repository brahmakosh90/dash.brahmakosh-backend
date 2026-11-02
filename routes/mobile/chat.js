import express from 'express';
import Chat from '../../models/Chat.js';
import { authenticate } from '../../middleware/auth.js';
import { getChatCompletion } from '../../utils/openai.js';
import { getPromptContent, PROMPT_KEYS } from '../../services/promptService.js';
import { getUserChatContext, buildContextPrompt, updateChatSummary, invalidateUserChatContext } from '../../services/userChatContext.js';

// Per-user processing lock — prevents concurrent requests for same user
const processingUsers = new Set();

const router = express.Router();

/**
 * Diagnostic endpoint - Check authentication status
 * GET /api/mobile/chat/debug
 * Headers: Authorization: Bearer <token>
 */
router.get('/debug', authenticate, async (req, res) => {
  try {
    const debugInfo = {
      hasUser: !!req.user,
      userId: req.user?._id?.toString(),
      userRole: req.user?.role,
      tokenRole: req.decodedRole,
      userEmail: req.user?.email,
      userIsActive: req.user?.isActive,
      roleMatch: req.user?.role === req.decodedRole,
      userObjectKeys: req.user ? Object.keys(req.user) : [],
      timestamp: new Date().toISOString()
    };
    
    console.log('[Chat Debug]', debugInfo);
    
    res.json({
      success: true,
      message: 'Debug information',
      data: debugInfo
    });
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get debug info'
    });
  }
});

/**
 * Create a new chat
 * POST /api/mobile/chat
 * Headers: Authorization: Bearer <token>
 * Body: { title? }
 */
router.post('/', authenticate, async (req, res) => {
  try {
    // CRITICAL: This endpoint is ONLY for 'user' role
    const tokenRole = req.decodedRole;
    
    if (tokenRole !== 'user') {
      console.error('[Chat POST] Access denied - Wrong role:', {
        tokenRole: tokenRole,
        requiredRole: 'user'
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This endpoint is only for 'user' role. Your current role is '${tokenRole}'. Please login as a user.`,
        error: 'INVALID_ROLE',
        requiredRole: 'user',
        currentRole: tokenRole
      });
    }

    if (!req.user) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
        error: 'USER_NOT_FOUND'
      });
    }

    const { title } = req.body;

    const chat = new Chat({
      userId: req.user._id,
      title: title || 'New Chat',
      messages: []
    });

    await chat.save();

    res.status(201).json({
      success: true,
      message: 'Chat created successfully',
      data: {
        chatId: chat._id,
        title: chat.title,
        createdAt: chat.createdAt
      }
    });
  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create chat'
    });
  }
});

/**
 * Get all chats for the user
 * GET /api/mobile/chat
 * Headers: Authorization: Bearer <token>
 */
router.get('/', authenticate, async (req, res) => {
  try {
    // CRITICAL: This endpoint is ONLY for 'user' role
    // Get role from token (source of truth)
    const tokenRole = req.decodedRole;
    const userRole = req.user?.role;
    
    // Debug logging
    console.log('[Chat GET] Request received:', {
      hasUser: !!req.user,
      userId: req.user?._id?.toString(),
      tokenRole: tokenRole,
      userRole: userRole,
      userEmail: req.user?.email,
      endpoint: '/api/mobile/chat',
      requiredRole: 'user'
    });

    // STRICT CHECK: Only 'user' role allowed
    if (tokenRole !== 'user') {
      console.error('[Chat GET] Access denied - Wrong role:', {
        tokenRole: tokenRole,
        userRole: userRole,
        requiredRole: 'user',
        userId: req.user?._id?.toString(),
        message: `This endpoint requires 'user' role. Current role: '${tokenRole}'`
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This endpoint is only for 'user' role. Your current role is '${tokenRole}'. Please login as a user.`,
        error: 'INVALID_ROLE',
        requiredRole: 'user',
        currentRole: tokenRole
      });
    }

    // Double check user object role matches
    if (userRole && userRole !== 'user') {
      console.warn('[Chat GET] User object role mismatch, but token role is correct. Updating user.role.');
      req.user.role = 'user';
    }

    if (!req.user) {
      console.error('[Chat GET] No user object in request');
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
        error: 'USER_NOT_FOUND'
      });
    }

    console.log('[Chat GET] Access granted, fetching chats for user:', req.user._id);

    const chats = await Chat.find({ userId: req.user._id })
      .select('_id title messages createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    // Add message count and last message preview
    const chatsWithPreview = chats.map(chat => ({
      chatId: chat._id,
      title: chat.title,
      messageCount: chat.messages.length,
      lastMessage: chat.messages.length > 0 
        ? chat.messages[chat.messages.length - 1].content.substring(0, 100)
        : null,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt
    }));

    res.json({
      success: true,
      data: {
        chats: chatsWithPreview
      }
    });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch chats'
    });
  }
});

/**
 * Get a specific chat with all messages
 * GET /api/mobile/chat/:chatId
 * Headers: Authorization: Bearer <token>
 */
router.get('/:chatId', authenticate, async (req, res) => {
  try {
    // CRITICAL: This endpoint is ONLY for 'user' role
    const tokenRole = req.decodedRole;
    
    if (tokenRole !== 'user') {
      console.error('[Chat GET :chatId] Access denied - Wrong role:', {
        tokenRole: tokenRole,
        requiredRole: 'user'
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This endpoint is only for 'user' role. Your current role is '${tokenRole}'. Please login as a user.`,
        error: 'INVALID_ROLE',
        requiredRole: 'user',
        currentRole: tokenRole
      });
    }

    if (!req.user) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
        error: 'USER_NOT_FOUND'
      });
    }

    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      userId: req.user._id
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    res.json({
      success: true,
      data: {
        chatId: chat._id,
        title: chat.title,
        messages: chat.messages,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      }
    });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch chat'
    });
  }
});

/**
 * Send a message in a chat (create new chat if chatId not provided)
 * POST /api/mobile/chat/:chatId/message
 * Headers: Authorization: Bearer <token>
 * Body: { message }
 */
router.post('/:chatId/message', authenticate, async (req, res) => {
  // Set only once this request owns the per-user lock, so a rejected duplicate can't release it.
  let lockedUserId = null;
  try {
    // CRITICAL: This endpoint is ONLY for 'user' role
    const tokenRole = req.decodedRole;
    
    if (tokenRole !== 'user') {
      console.error('[Chat POST :chatId/message] Access denied - Wrong role:', {
        tokenRole: tokenRole,
        requiredRole: 'user'
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This endpoint is only for 'user' role. Your current role is '${tokenRole}'. Please login as a user.`,
        error: 'INVALID_ROLE',
        requiredRole: 'user',
        currentRole: tokenRole
      });
    }

    if (!req.user) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
        error: 'USER_NOT_FOUND'
      });
    }

    const userId = req.user._id.toString();

    // Block if previous request still processing
    if (processingUsers.has(userId)) {
      return res.status(429).json({
        success: false,
        message: 'Please wait for the previous response to complete before sending a new message.',
        error: 'PROCESSING_IN_PROGRESS'
      });
    }

    processingUsers.add(userId);
    lockedUserId = userId;

    const { chatId } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    // Find or create chat
    let chat = await Chat.findOne({
      _id: chatId,
      userId: req.user._id
    });

    // If chatId provided but not found, create new chat
    if (!chat && chatId !== 'new') {
      // Create new chat if chatId doesn't exist
      chat = new Chat({
        userId: req.user._id,
        title: message.substring(0, 50) || 'New Chat',
        messages: []
      });
    } else if (!chat) {
      // Create new chat if chatId is 'new'
      chat = new Chat({
        userId: req.user._id,
        title: message.substring(0, 50) || 'New Chat',
        messages: []
      });
    }

    // Add user message
    chat.messages.push({
      role: 'user',
      content: message.trim()
    });

    let systemPrompt = 'You are Brahmakosh, a warm and empathetic spiritual wellness guide. Offer concise, actionable guidance rooted in mindfulness and positive habits.';
    try {
      const storedPrompt = await getPromptContent(PROMPT_KEYS.MOBILE_CHAT_ASSISTANT);
      if (storedPrompt && typeof storedPrompt === 'string' && storedPrompt.trim().length > 0) {
        systemPrompt = storedPrompt.trim();
      }
    } catch (promptError) {
      console.warn('[Chat POST :chatId/message] Failed to load mobile chat prompt. Using fallback.', promptError.message);
    }

    // Personalise: user's first name and what earlier sessions were about (failure just means no extra context)
    try {
      const userContext = await getUserChatContext(req.user._id, { excludeChatId: chat._id });
      systemPrompt += buildContextPrompt(userContext);
    } catch (contextError) {
      console.warn('[Chat POST :chatId/message] Could not load user context:', contextError.message);
    }

    // Prepare messages for OpenAI (format: { role, content })
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...chat.messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    ];

    // Get response from OpenAI
    const aiResponse = await getChatCompletion(openaiMessages);

    // Add assistant message
    chat.messages.push({
      role: 'assistant',
      content: aiResponse.content
    });

    // Update chat title if it's the first message
    if (chat.messages.length === 2 && chat.title === 'New Chat') {
      chat.title = message.substring(0, 50) || 'New Chat';
    }

    await chat.save();

    // Keep the topic summary fresh (after the 1st exchange, then every 8th user message); background only
    const userMessageCount = chat.messages.filter(m => m.role === 'user').length;
    if (userMessageCount === 1 || userMessageCount % 8 === 0) {
      updateChatSummary(chat._id).then(() => invalidateUserChatContext(req.user._id)).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Message sent successfully',
      data: {
        chatId: chat._id,
        userMessage: {
          role: 'user',
          content: message.trim()
        },
        assistantMessage: {
          role: 'assistant',
          content: aiResponse.content
        },
        usage: aiResponse.usage
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to send message'
    });
  } finally {
    if (lockedUserId) processingUsers.delete(lockedUserId);
  }
});

/**
 * Delete a chat
 * DELETE /api/mobile/chat/:chatId
 * Headers: Authorization: Bearer <token>
 */
router.delete('/:chatId', authenticate, async (req, res) => {
  try {
    // CRITICAL: This endpoint is ONLY for 'user' role
    const tokenRole = req.decodedRole;
    
    if (tokenRole !== 'user') {
      console.error('[Chat DELETE :chatId] Access denied - Wrong role:', {
        tokenRole: tokenRole,
        requiredRole: 'user'
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This endpoint is only for 'user' role. Your current role is '${tokenRole}'. Please login as a user.`,
        error: 'INVALID_ROLE',
        requiredRole: 'user',
        currentRole: tokenRole
      });
    }

    if (!req.user) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
        error: 'USER_NOT_FOUND'
      });
    }

    const { chatId } = req.params;

    const chat = await Chat.findOneAndDelete({
      _id: chatId,
      userId: req.user._id
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    res.json({
      success: true,
      message: 'Chat deleted successfully'
    });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete chat'
    });
  }
});

export default router;

