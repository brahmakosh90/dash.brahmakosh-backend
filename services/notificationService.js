import Notification from '../models/Notification.js';
import axios from 'axios';

// Brevo Email Service
const sendEmail = async (to, subject, htmlContent) => {
  if (!process.env.USE_BREVO || !process.env.BREVO_API_KEY) {
    return;
  }
  
  try {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: process.env.BREVO_FROM_NAME, email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent
    }, {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('[Email] Error:', error.response?.data || error.message);
    throw error;
  }
};

// Twilio SMS Service
const sendSMS = async (to, message) => {
  if (process.env.TWILIO_WHATSAPP_ENABLED !== 'true' || !process.env.TWILIO_WHATSAPP_ACCOUNT_SID) return;
  
  try {
    const auth = Buffer.from(`${process.env.TWILIO_WHATSAPP_ACCOUNT_SID}:${process.env.TWILIO_WHATSAPP_AUTH_TOKEN}`).toString('base64');
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_WHATSAPP_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        To: to,
        MessagingServiceSid: process.env.TWILIO_WHATSAPP_MESSAGING_SERVICE_SID,
        Body: message
      }),
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    console.log('✅ SMS sent to:', to);
  } catch (error) {
    console.error('❌ SMS error:', error.response?.data || error.message);
  }
};

// Twilio WhatsApp Service
const sendWhatsApp = async (to, message) => {
  if (process.env.TWILIO_WHATSAPP_ENABLED !== 'true' || !process.env.TWILIO_WHATSAPP_FROM) return;
  
  try {
    const auth = Buffer.from(`${process.env.TWILIO_WHATSAPP_ACCOUNT_SID}:${process.env.TWILIO_WHATSAPP_AUTH_TOKEN}`).toString('base64');
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_WHATSAPP_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        To: `whatsapp:${to}`,
        From: process.env.TWILIO_WHATSAPP_FROM,
        Body: message
      }),
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    console.log('✅ WhatsApp sent to:', to);
  } catch (error) {
    console.error('❌ WhatsApp error:', error.response?.data || error.message);
  }
};

class NotificationService {
  // Send daily reminder
  async sendDailyReminder(userId, userSankalpId, sankalpTitle) {
    try {
      const User = (await import('../models/User.js')).default;
      const user = await User.findById(userId);

      const notification = new Notification({
        userId,
        type: 'daily_reminder',
        title: '🙏 Daily Sankalp Reminder',
        message: `Don't forget to complete your "${sankalpTitle}" today!`,
        data: { userSankalpId }
      });
      await notification.save();

      if (user?.email) {
        try {
          await sendEmail(
            user.email,
            '🙏 Daily Sankalp Reminder',
            `<h2>Time to practice!</h2><p>Don't forget to complete your <strong>${sankalpTitle}</strong> today!</p>`
          );
          console.log('✅ Email sent to:', user.email);
        } catch (error) {
          console.error('❌ Email error:', error.message);
        }
      }

      if (user?.mobile) {
        console.log('📱 User mobile:', user.mobile);
        try {
          await sendSMS(user.mobile, `🙏 Daily Reminder: Don't forget to complete your "${sankalpTitle}" today. Stay committed!`);
        } catch (error) {
          console.error('❌ SMS error:', error.message);
        }
        try {
          await sendWhatsApp(user.mobile, `🙏 Daily Reminder: Don't forget to complete your "${sankalpTitle}" today. Stay committed!`);
        } catch (error) {
          console.error('❌ WhatsApp error:', error.message);
        }
      } else {
        console.log('⚠️ No mobile number for user:', userId);
      }

      return notification;
    } catch (error) {
      console.error('Error sending daily reminder:', error);
      throw error;
    }
  }

  // Send streak alert
  async sendStreakAlert(userId, userSankalpId, streak, sankalpTitle) {
    try {
      const User = (await import('../models/User.js')).default;
      const user = await User.findById(userId);

      const notification = new Notification({
        userId,
        type: 'streak_alert',
        title: `🔥 ${streak} Day Streak!`,
        message: `Amazing! You're on a ${streak}-day streak for "${sankalpTitle}". Keep it up!`,
        data: { userSankalpId, streak }
      });
      await notification.save();

      if (user?.email) {
        await sendEmail(
          user.email,
          `🔥 ${streak} Day Streak!`,
          `<h2>Amazing Achievement!</h2><p>You're on a <strong>${streak}-day streak</strong> for ${sankalpTitle}. Keep it up!</p>`
        );
      }

      if (user?.mobile) {
        await sendSMS(user.mobile, `🔥 ${streak} Day Streak! Amazing progress on ${sankalpTitle}. Keep it up!`);
        await sendWhatsApp(user.mobile, `🔥 ${streak} Day Streak! Amazing progress on ${sankalpTitle}. Keep it up!`);
      }

      return notification;
    } catch (error) {
      console.error('Error sending streak alert:', error);
      throw error;
    }
  }

  // Send completion notification
  async sendCompletionNotification(userId, userSankalpId, sankalpTitle, karmaEarned) {
    try {
      const User = (await import('../models/User.js')).default;
      const user = await User.findById(userId);

      const notification = new Notification({
        userId,
        type: 'completion',
        title: '🎉 Sankalp Completed!',
        message: `Congratulations! You completed "${sankalpTitle}" and earned ${karmaEarned} karma points!`,
        data: { userSankalpId, karmaEarned }
      });
      await notification.save();

      if (user?.email) {
        await sendEmail(
          user.email,
          '🎉 Sankalp Completed!',
          `<h2>Congratulations!</h2><p>You completed <strong>${sankalpTitle}</strong> and earned <strong>${karmaEarned} karma points</strong>!</p>`
        );
      }

      if (user?.mobile) {
        await sendSMS(user.mobile, `🎉 Sankalp completed! You earned ${karmaEarned} karma points. Keep up the great work!`);
        await sendWhatsApp(user.mobile, `🎉 Sankalp completed! You earned ${karmaEarned} karma points. Keep up the great work!`);
      }

      return notification;
    } catch (error) {
      console.error('Error sending completion notification:', error);
      throw error;
    }
  }

  // Send milestone notification
  async sendMilestoneNotification(userId, userSankalpId, milestone, sankalpTitle) {
    try {
      const notification = new Notification({
        userId,
        type: 'milestone',
        title: `🏆 ${milestone}% Complete!`,
        message: `You're ${milestone}% done with "${sankalpTitle}". Keep going!`,
        data: {
          userSankalpId
        }
      });
      await notification.save();
      return notification;
    } catch (error) {
      console.error('Error sending milestone notification:', error);
      throw error;
    }
  }

  // Get user notifications
  async getUserNotifications(userId, limit = 20, skip = 0) {
    try {
      const notifications = await Notification.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip);
      
      const unreadCount = await Notification.countDocuments({ userId, isRead: false });
      
      return {
        notifications,
        unreadCount
      };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      throw error;
    }
  }

  // Mark notification as read
  async markAsRead(notificationId, userId) {
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { isRead: true, readAt: new Date() },
        { new: true }
      );
      return notification;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      throw error;
    }
  }

  // Mark all as read
  async markAllAsRead(userId) {
    try {
      await Notification.updateMany(
        { userId, isRead: false },
        { isRead: true, readAt: new Date() }
      );
      return true;
    } catch (error) {
      console.error('Error marking all as read:', error);
      throw error;
    }
  }

  // ============ DREAM REQUEST NOTIFICATIONS ============
  
  // Send dream request received confirmation
  async sendDreamRequestReceived(userEmail, userName, dreamSymbol) {
    try {
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">✅ Request Received!</h1>
          </div>
          <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
            <p>Dear ${userName || 'User'},</p>
            <p>Thank you for your dream request. We have received your request for:</p>
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
              <h3 style="margin: 0 0 10px 0; color: #10b981;">Dream Symbol</h3>
              <p style="font-size: 18px; font-weight: 600; margin: 0;">${dreamSymbol}</p>
            </div>
            <p>Our team will review your request and add the dream meaning to our database soon.</p>
            <p><strong>What happens next?</strong></p>
            <ul>
              <li>📝 Our experts will research the dream meaning</li>
              <li>✍️ We'll add detailed interpretation with Vedic insights</li>
              <li>📧 You'll receive an email when it's ready</li>
              <li>🔍 You can then search and view the meaning</li>
            </ul>
            <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
              We typically process requests within 24-48 hours. Thank you for your patience!
            </p>
          </div>
          <div style="text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px;">
            <p>© ${new Date().getFullYear()} Brahmakosh. All rights reserved.</p>
          </div>
        </div>
      `;

      await sendEmail(userEmail, `✅ Dream Request Received - ${dreamSymbol}`, htmlContent);
      console.log('✅ Dream request confirmation sent to:', userEmail);
    } catch (error) {
      console.error('Error sending dream request confirmation:', error);
    }
  }

  // Send dream ready notification
  async sendDreamReady(userEmail, userName, dreamSymbol, dreamUrl) {
    try {
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">🌙 Dream Meaning Ready!</h1>
          </div>
          <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
            <p>Dear ${userName || 'User'},</p>
            <p>Great news! The dream meaning you requested is now available in our database.</p>
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #6366f1;">
              <h3 style="margin: 0 0 10px 0; color: #6366f1;">Dream Symbol</h3>
              <p style="font-size: 18px; font-weight: 600; margin: 0;">${dreamSymbol}</p>
            </div>
            <p>You can now search for "<strong>${dreamSymbol}</strong>" in the Swapna Decoder to view:</p>
            <ul>
              <li>✅ Detailed interpretation</li>
              <li>✅ Positive & negative aspects</li>
              <li>✅ Vedic references</li>
              <li>✅ Astrological significance</li>
              <li>✅ Remedies & mantras</li>
            </ul>
            <div style="text-align: center; margin: 20px 0;">
              <a href="${dreamUrl || 'https://brahmakosh.com/swapna-decoder'}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600;">View Dream Meaning</a>
            </div>
            <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
              Thank you for using Brahmakosh Swapna Decoder. We hope this helps you understand your dreams better.
            </p>
          </div>
          <div style="text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px;">
            <p>© ${new Date().getFullYear()} Brahmakosh. All rights reserved.</p>
            <p>Decode your dreams with Vedic wisdom</p>
          </div>
        </div>
      `;

      await sendEmail(userEmail, `🌙 Your Dream "${dreamSymbol}" is Ready!`, htmlContent);
    } catch (error) {
      console.error('[NotificationService] Error sending dream ready notification:', error);
      throw error;
    }
  }
}

export default new NotificationService();
