import cron from 'node-cron';
import UserSankalp from '../models/UserSankalp.js';
import notificationService from './notificationService.js';
import CronJobLog from '../models/CronJobLog.js';
import { runAbandonmentCheck } from './sankalpAbandonment.js';

// Track sent reminders to avoid duplicates (in-memory cache)
const sentRemindersToday = new Set();

// Reset sent reminders at midnight
cron.schedule('0 0 * * *', () => {
  sentRemindersToday.clear();
  console.log('✅ Reminder cache cleared for new day');
});

// Daily reminder - runs every 1 minute to check custom reminder times
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find all active sankalpas with populated user data
    const activeSankalpas = await UserSankalp.find({ 
      status: 'active'
    }).populate('sankalpId userId');

    let remindersSent = 0;

    for (const userSankalp of activeSankalpas) {
      // Skip if user data not populated
      if (!userSankalp.userId || !userSankalp.sankalpId) continue;

      // Create unique key for today's reminder
      const reminderKey = `${userSankalp._id}_${today.toISOString().split('T')[0]}`;
      
      // Skip if already sent today
      if (sentRemindersToday.has(reminderKey)) {
        continue;
      }

      // Check if user already reported today
      const todayReport = userSankalp.dailyReports.find(r => {
        const reportDate = new Date(r.date);
        reportDate.setHours(0, 0, 0, 0);
        return reportDate.getTime() === today.getTime();
      });

      // Send reminder only if not reported yet
      if (!todayReport || todayReport.status === 'not_reported') {
        // Get user timezone (default to IST)
        const userTimezone = userSankalp.userId.timezone || 'Asia/Kolkata';
        
        // Get current time in user's timezone
        const userTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
        const currentHour = userTime.getHours();
        const currentMinute = userTime.getMinutes();
        
        // Check custom reminder time or default to 9 AM
        const reminderTime = userSankalp.reminderTime || '09:00';
        const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
        
        // Calculate time difference in minutes
        const reminderTimeInMinutes = reminderHour * 60 + reminderMinute;
        const currentTimeInMinutes = currentHour * 60 + currentMinute;
        const timeDiff = Math.abs(currentTimeInMinutes - reminderTimeInMinutes);
        
        // Send reminder if within 1 minute of scheduled time
        if (timeDiff < 1) {
          try {
            await notificationService.sendDailyReminder(
              userSankalp.userId._id,
              userSankalp._id,
              userSankalp.sankalpId.title
            );
            
            // Mark as sent
            sentRemindersToday.add(reminderKey);
            remindersSent++;
            
            console.log(`✅ [${currentHour}:${String(currentMinute).padStart(2, '0')}] Reminder sent to ${userSankalp.userId.email} (${userTimezone}) for "${userSankalp.sankalpId.title}"`);
          } catch (error) {
            console.error(`❌ Failed to send reminder to user ${userSankalp.userId._id}:`, error.message);
          }
        }
      }
    }

    // Only log when reminders are sent
    if (remindersSent > 0) {
      const serverTime = now.toLocaleTimeString('en-US', { hour12: false });
      console.log(`📧 [${serverTime}] Daily reminders sent to ${remindersSent} users`);
    }
  } catch (error) {
    // Log error but don't crash - will retry next minute
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
      console.error(`⚠️ [${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}] MongoDB connection issue - will retry next minute`);
    } else {
      console.error('Error sending daily reminders:', error.message);
    }
  }
});

// Check for abandoned sankalpas - runs daily at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('Running sankalp abandonment check...');
  const summary = await runAbandonmentCheck({ UserSankalp, notificationService, CronJobLog });
  console.log(`Abandonment check done: ${summary.abandoned} abandoned, ${summary.processed} processed, ${summary.failed} failed`);
});

console.log('✅ Sankalp cron jobs scheduled:');
console.log('   - Reminder check every 1 minute');
console.log('   - Abandonment check at midnight');
console.log('   - Reminder cache reset at midnight');
