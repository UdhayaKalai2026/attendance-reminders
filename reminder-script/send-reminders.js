/**
 * Attendance check-in/check-out push reminders - FREE version.
 *
 * Run by GitHub Actions every 5 minutes (see ../.github/workflows/reminders.yml)
 * instead of a paid Firebase Cloud Function. Uses the Firebase Admin SDK to
 * read Firestore and send push notifications - both are free, no Blaze
 * billing plan needed anywhere in this setup.
 *
 * IMPORTANT: GitHub Actions runs this on a server set to UTC time, but shift
 * timings in the app ("09:00" etc.) are entered in India time (IST, UTC+5:30).
 * Every time calculation below is explicitly converted to IST so this lines
 * up correctly no matter what timezone the server itself is in.
 *
 * Also, instead of only firing inside a narrow 5-minute window (which a
 * slightly-delayed GitHub Actions run could skip over entirely), this writes
 * a small "already reminded today" flag to Firestore the first time it sends
 * one, and checks that flag before sending again - so a late run can never
 * cause a missed reminder.
 *
 * For every employee with a fixed shift (not "owner" role, not flexible
 * timing) who has push notifications turned on in the app:
 *   - if they still haven't clocked "in" once their grace period has passed,
 *     they get a "Forgot to check in?" push (once per day).
 *   - if their last punch of the day isn't "out" once shift end has passed,
 *     they get a "Forgot to check out?" push (once per day).
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Returns a Date whose getUTC*() methods give India wall-clock time,
// regardless of what timezone this script is actually running in.
function nowInIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

// Midnight today, in IST, expressed as a real UTC instant Firestore can compare against.
function todayStartUTC(nowIST) {
  const istMidnightShifted = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(), 0, 0, 0);
  return new Date(istMidnightShifted - IST_OFFSET_MS);
}

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function istDateKey(nowIST) {
  const y = nowIST.getUTCFullYear();
  const m = String(nowIST.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nowIST.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function main() {
  const nowIST = nowInIST();
  const nowMinutes = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const dateKey = istDateKey(nowIST);
  const todayStart = todayStartUTC(nowIST);

  const [shiftDoc, usersSnap, attSnap] = await Promise.all([
    db.collection('settings').doc('shift').get(),
    db.collection('users').get(),
    db.collection('attendance').where('timestamp', '>=', todayStart).get()
  ]);

  const shiftSettings = shiftDoc.exists
    ? shiftDoc.data()
    : { startTime: '09:30', endTime: '18:00', graceMinutes: 15 };

  const byUser = {};
  attSnap.forEach((doc) => {
    const d = doc.data();
    if (!d.timestamp || !d.uid) return;
    if (!byUser[d.uid]) byUser[d.uid] = [];
    byUser[d.uid].push({ type: d.type, when: d.timestamp.toDate() });
  });
  Object.keys(byUser).forEach((uid) => byUser[uid].sort((a, b) => a.when - b.when));

  const candidates = [];

  usersSnap.forEach((userDoc) => {
    const uid = userDoc.id;
    const u = userDoc.data();
    if (!u || u.role === 'owner') return;
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
    if (!hasIn && nowMinutes >= inThreshold) {
      candidates.push({
        uid, tokens: u.fcmTokens, kind: 'in',
        title: 'Forgot to check in?',
        body: `${u.name || 'You'} haven't clocked in yet today.`
      });
    }
    if (hasIn && lastType !== 'out' && nowMinutes >= end) {
      candidates.push({
        uid, tokens: u.fcmTokens, kind: 'out',
        title: 'Forgot to check out?',
        body: `${u.name || 'You'} are still clocked in - don't forget to check out.`
      });
    }
  });

  const toSend = [];
  for (const c of candidates) {
    const flagRef = db.collection('reminderLog').doc(`${c.uid}_${dateKey}_${c.kind}`);
    const flagDoc = await flagRef.get();
    if (flagDoc.exists) continue;
    toSend.push(c);
    await flagRef.set({ uid: c.uid, kind: c.kind, dateKey, sentAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  await Promise.all(
    toSend.map((s) =>
      admin
        .messaging()
        .sendEachForMulticast({
          tokens: s.tokens,
          notification: { title: s.title, body: s.body }
        })
        .catch((err) => console.error('Push send failed for', s.uid, err))
    )
  );

  console.log(`IST time now: ${String(nowIST.getUTCHours()).padStart(2,'0')}:${String(nowIST.getUTCMinutes()).padStart(2,'0')} on ${dateKey}`);
  console.log(`Reminder run complete - ${toSend.length} notification(s) sent (of ${candidates.length} candidates).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
