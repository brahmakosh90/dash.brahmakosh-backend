import express from 'express';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import User from '../models/User.js';
import Partner from '../models/Partner.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get all conversations for a user
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    const query = userType === 'user'
      ? { 'participants.user.id': userId }
      : { 'participants.partner.id': userId };

    const conversations = await Conversation.find(query)
      .sort({ 'lastMessage.timestamp': -1 })
      .lean();

    res.json({
      success: true,
      conversations
    });

  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversations',
      error: error.message
    });
  }
});

// Get messages for a specific conversation
router.get('/messages/:conversationId', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const messages = await Message.find({
      conversationId,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalMessages = await Message.countDocuments({
      conversationId,
      isDeleted: false
    });

    res.json({
      success: true,
      messages: messages.reverse(), // Reverse to show oldest first
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalMessages,
        totalPages: Math.ceil(totalMessages / parseInt(limit)),
        hasMore: skip + messages.length < totalMessages
      }
    });

  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: error.message
    });
  }
});

// Start a new conversation or get existing one
router.post('/conversations/start', authMiddleware, async (req, res) => {
  try {
    const { otherUserId, otherUserType } = req.body;
    
    // CRITICAL: Validate authenticated user ID first
    const userId = req.user?.id;
    if (!userId) {
      console.error('Auth error: userId is missing from req.user', req.user);
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found in token'
      });
    }

    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    // Validate required fields
    if (!otherUserId || !otherUserType) {
      return res.status(400).json({
        success: false,
        message: 'Other user ID and type are required'
      });
    }

    // Validate that otherUserId is a valid string
    if (typeof otherUserId !== 'string' || otherUserId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Invalid other user ID format'
      });
    }

    // Validate userType
    if (!['user', 'partner'].includes(otherUserType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid other user type. Must be "user" or "partner"'
      });
    }

    // Trim the otherUserId to remove any whitespace
    const cleanOtherUserId = otherUserId.trim();

    // Log for debugging
    console.log('Starting conversation:', {
      userId: userId,
      userType: userType,
      otherUserId: cleanOtherUserId,
      otherUserType: otherUserType
    });

    // Generate conversation ID
    let conversationId;
    try {
      conversationId = userType === 'user'
        ? Message.generateConversationId(userId, cleanOtherUserId)
        : Message.generateConversationId(cleanOtherUserId, userId);
    } catch (error) {
      console.error('Error generating conversation ID:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate conversation ID',
        error: error.message
      });
    }

    // Check if conversation exists
    let conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      // Fetch participant data
      const currentUserData = userType === 'user'
        ? await User.findById(userId).select('email profile profileImage')
        : await Partner.findById(userId).select('name email profilePicture');

      if (!currentUserData) {
        return res.status(404).json({
          success: false,
          message: 'Current user not found'
        });
      }

      const otherUserData = otherUserType === 'user'
        ? await User.findById(cleanOtherUserId).select('email profile profileImage')
        : await Partner.findById(cleanOtherUserId).select('name email profilePicture');

      if (!otherUserData) {
        return res.status(404).json({
          success: false,
          message: 'Other user not found'
        });
      }

      // Create new conversation
      conversation = await Conversation.create({
        conversationId,
        participants: {
          user: {
            id: userType === 'user' ? userId : cleanOtherUserId,
            name: userType === 'user'
              ? currentUserData.profile?.name || 'User'
              : otherUserData.profile?.name || 'User',
            profilePicture: userType === 'user'
              ? currentUserData.profileImage
              : otherUserData.profileImage
          },
          partner: {
            id: userType === 'partner' ? userId : cleanOtherUserId,
            name: userType === 'partner'
              ? currentUserData.name
              : otherUserData.name,
            profilePicture: userType === 'partner'
              ? currentUserData.profilePicture
              : otherUserData.profilePicture
          }
        }
      });
    }

    res.json({
      success: true,
      conversation
    });

  } catch (error) {
    console.error('Error starting conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start conversation',
      error: error.message
    });
  }
});

// Send a message (fallback if Socket.IO fails)
router.post('/messages/send', authMiddleware, async (req, res) => {
  try {
    const { receiverId, receiverType, content, messageType = 'text', mediaUrl = null } = req.body;
    
    // CRITICAL: Validate authenticated user ID first
    const userId = req.user?.id;
    if (!userId) {
      console.error('Auth error: userId is missing from req.user', req.user);
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found in token'
      });
    }

    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    if (!receiverId || !receiverType || !content) {
      return res.status(400).json({
        success: false,
        message: 'Receiver ID, type, and content are required'
      });
    }

    // Validate receiverId
    if (typeof receiverId !== 'string' || receiverId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Invalid receiver ID format'
      });
    }

    // Validate receiverType
    if (!['user', 'partner'].includes(receiverType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid receiver type. Must be "user" or "partner"'
      });
    }

    const cleanReceiverId = receiverId.trim();

    // Generate conversation ID
    const conversationId = userType === 'user'
      ? Message.generateConversationId(userId, cleanReceiverId)
      : Message.generateConversationId(cleanReceiverId, userId);

    // Get sender data
    const senderData = userType === 'user'
      ? await User.findById(userId).select('email profile profileImage')
      : await Partner.findById(userId).select('name email profilePicture');

    if (!senderData) {
      return res.status(404).json({
        success: false,
        message: 'Sender not found'
      });
    }

    // Create message
    const message = await Message.create({
      conversationId,
      sender: {
        id: userId,
        model: userType === 'user' ? 'User' : 'Partner',
        name: userType === 'user'
          ? senderData.profile?.name || 'User'
          : senderData.name,
        profilePicture: userType === 'user'
          ? senderData.profileImage
          : senderData.profilePicture
      },
      receiver: {
        id: cleanReceiverId,
        model: receiverType === 'user' ? 'User' : 'Partner'
      },
      messageType,
      content,
      mediaUrl
    });

    // Update conversation
    const updateData = {
      lastMessage: {
        content: message.content,
        senderId: message.sender.id,
        senderModel: message.sender.model,
        timestamp: message.createdAt,
        isRead: false
      }
    };

    if (userType === 'user') {
      updateData.$inc = { 'unreadCount.partner': 1 };
    } else {
      updateData.$inc = { 'unreadCount.user': 1 };
    }

    await Conversation.findOneAndUpdate(
      { conversationId },
      updateData,
      { upsert: true }
    );

    res.json({
      success: true,
      message: message.toObject()
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// Mark messages as read
router.patch('/messages/read', authMiddleware, async (req, res) => {
  try {
    const { messageIds, conversationId } = req.body;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found'
      });
    }

    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    if (!messageIds || !conversationId) {
      return res.status(400).json({
        success: false,
        message: 'Message IDs and conversation ID are required'
      });
    }

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Message IDs must be a non-empty array'
      });
    }

    // Mark messages as read
    await Message.updateMany(
      {
        _id: { $in: messageIds },
        'receiver.id': userId,
        isRead: false
      },
      {
        isRead: true,
        readAt: new Date()
      }
    );

    // Update unread count
    const updateField = userType === 'user'
      ? { 'unreadCount.user': 0 }
      : { 'unreadCount.partner': 0 };

    await Conversation.updateOne(
      { conversationId },
      updateField
    );

    res.json({
      success: true,
      message: 'Messages marked as read'
    });

  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark messages as read',
      error: error.message
    });
  }
});

// Delete a message
router.delete('/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found'
      });
    }

    if (!messageId || messageId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message ID is required'
      });
    }

    const message = await Message.findOne({
      _id: messageId,
      'sender.id': userId
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found or you do not have permission to delete it'
      });
    }

    message.isDeleted = true;
    message.deletedAt = new Date();
    await message.save();

    res.json({
      success: true,
      message: 'Message deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: error.message
    });
  }
});

// Get unread message count
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found'
      });
    }

    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    const query = userType === 'user'
      ? { 'participants.user.id': userId }
      : { 'participants.partner.id': userId };

    const conversations = await Conversation.find(query).lean();

    const totalUnread = conversations.reduce((sum, conv) => {
      return sum + (userType === 'user' ? conv.unreadCount.user : conv.unreadCount.partner);
    }, 0);

    res.json({
      success: true,
      totalUnread,
      conversationsWithUnread: conversations.filter(conv =>
        (userType === 'user' ? conv.unreadCount.user : conv.unreadCount.partner) > 0
      ).length
    });

  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread count',
      error: error.message
    });
  }
});

// Search messages
router.get('/messages/search', authMiddleware, async (req, res) => {
  try {
    const { query, conversationId } = req.query;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found'
      });
    }

    if (!query || query.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    const searchQuery = {
      content: { $regex: query, $options: 'i' },
      isDeleted: false,
      $or: [
        { 'sender.id': userId },
        { 'receiver.id': userId }
      ]
    };

    if (conversationId) {
      searchQuery.conversationId = conversationId;
    }

    const messages = await Message.find(searchQuery)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      messages
    });

  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search messages',
      error: error.message
    });
  }
});

// Archive conversation
router.patch('/conversations/:conversationId/archive', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed: User ID not found'
      });
    }

    const userType = req.user.role === 'partner' ? 'partner' : 'user';

    if (!conversationId || conversationId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Conversation ID is required'
      });
    }

    const updateField = userType === 'user'
      ? { 'isArchived.user': true }
      : { 'isArchived.partner': true };

    const conversation = await Conversation.findOneAndUpdate(
      { conversationId },
      updateField,
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    res.json({
      success: true,
      message: 'Conversation archived successfully',
      conversation
    });

  } catch (error) {
    console.error('Error archiving conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to archive conversation',
      error: error.message
    });
  }
});

export default router;