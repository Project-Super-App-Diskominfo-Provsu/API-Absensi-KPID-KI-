import { readNotificationConfig } from './config/notification-env.js';
import { createFirebaseSender } from './modules/notification/notification.sender.js';

try {
  const config = readNotificationConfig();
  const sender = await createFirebaseSender(
    config.FIREBASE_PROJECT_ID,
    config.GOOGLE_APPLICATION_CREDENTIALS,
  );
  await sender.close();
  console.log('Firebase project and service account format validated. No push notification sent.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Notification configuration check failed');
  process.exitCode = 1;
}
