/**
 * Attendance check-in/check-out push reminders - FREE version.
 *
 * Run by GitHub Actions every 5 minutes (see ../.github/workflows/reminders.yml)
 * instead of a paid Firebase Cloud Function. Uses the Firebase Admin SDK to
 * read Firestore and send push notifications - both are free, no Blaze
 * billing plan needed anywhere in this setup.
 *
 * For every employee with a fixed shift (not "owner" role, not flexible
 * timing) who has push notifications turned on in the app:
 *   - if they still haven't clocked "in" within 5 minutes of their grace
 *     period ending, they get a "Forgot to check in?" push.
 *   - if their last punch of the day isn't "out" within 5 minutes of their
 *     shift end time, they get a "Forgot to check out?" push.
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [shiftDoc, usersSnap, attSnap] = await Promise.all([
    db.collection('settings').doc('shift').get(),
    db.collection('users').get(),
    db.collection('attendance').where('timestamp', '>=', todayStart).get()
  ]);

  const shiftSettings = shiftDoc.exists
    ? shiftDoc.data()
    : { startTime: '09:30', endTime: '18:00', graceMinutes: 15 };

  // Group today's punches by employee, sorted chronologically, so we can
  // tell whether they've clocked in at all and what their most recent
  // punch type is (in progress vs already clocked out).
  const byUser = {};
  attSnap.forEach((doc) => {
    const d = doc.data();
    if (!d.timestamp || !d.uid) return;
    if (!byUser[d.uid]) byUser[d.uid] = [];
    byUser[d.uid].push({ type: d.type, when: d.timestamp.toDate() });
  });
  Object.keys(byUser).forEach((uid) => byUser[uid].sort((a, b) => a.when - b.when));

  const sends = [];

  usersSnap.forEach((userDoc) => {
    const uid = userDoc.id;
    const u = userDoc.data();
    if (!u || u.role === 'owner') return; // owners run flexible timing
    if (u.timingMode === 'flexible') return;
    if (!Array.isArray(u.fcmTokens) || !u.fcmTokens.length) return;

    const start = toMinutes(u.shiftStart || shiftSettings.startTime);
    const end = toMinutes(u.shiftEnd || shiftSettings.endTime);
    const grace = u.graceMinutes != null ? u.graceMinutes : (shiftSettings.graceMinutes || 0);
    if (start == null || end == null) return;

    const punches = byUser[uid] || [];
    const hasIn = punches.some((p) => p.type === 'in');
    const lastType = punches.length ? punches[punches.length - 1].type : 'none';

    const inThreshold = start + grace;
    const notYetIn = !hasIn && nowMinutes >= inThreshold && nowMinutes < inThreshold + 5;
    const notYetOut = hasIn && lastType !== 'out' && nowMinutes >= end && nowMinutes < end + 5;

    if (notYetIn) {
      sends.push({
        tokens: u.fcmTokens,
        title: 'Forgot to check in?',
        body: `${u.name || 'You'} haven't clocked in yet today.`
      });
    }
    if (notYetOut) {
      sends.push({
        tokens: u.fcmTokens,
        title: 'Forgot to check out?',
        body: `${u.name || 'You'} are still clocked in - don't forget to check out.`
      });
    }
  });

  for (const s of sends) {
    try {
      await admin.messaging().sendEachForMulticast({
        tokens: s.tokens,
        notification: { title: s.title, body: s.body }
      });
    } catch (e) {
      console.error('Push send failed:', e.message);
    }
  }

  console.log(`Reminder run complete - ${sends.length} notification(s) sent.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
