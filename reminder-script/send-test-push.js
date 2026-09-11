/**
 * ONE-OFF manual test - sends a single push notification to a specific
 * FCM token, using the same Firebase Admin SDK setup as send-reminders.js.
 *
 * Run manually from GitHub Actions (workflow_dispatch) to verify push
 * actually reaches a device, without fighting the Firebase Console UI.
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const TOKEN = process.env.TEST_TOKEN;

async function main() {
  if (!TOKEN) {
    console.error('No TEST_TOKEN provided.');
    process.exit(1);
  }
  try {
    const response = await admin.messaging().send({
      token: TOKEN,
      notification: {
        title: 'Test push',
        body: 'If you see this, background push is working.'
      }
    });
    console.log('SUCCESS - message ID:', response);
  } catch (err) {
    console.error('FAILED:', err.code, '-', err.message);
    process.exit(1);
  }
}

main();
