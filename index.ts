import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createHash } from "node:crypto";

initializeApp();
const db = getFirestore();
const REGION = "asia-south1";
const PRICE_BDT = 39;
const PLAN_DAYS = 30;

function requireUser(request: any): string {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "প্রথমে লগইন করুন।");
  return request.auth.uid;
}
function requireAdmin(request: any): string {
  const uid = requireUser(request);
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access প্রয়োজন।");
  }
  return uid;
}
function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Customer sends exactly ৳39 to the published bKash number, then submits
 * the transaction ID. This function only creates a PENDING request.
 * It never activates Pro based on client input.
 */
export const submitProPayment = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const uid = requireUser(request);
  const transactionId = cleanText(request.data?.transactionId, 80).toUpperCase();
  const senderNumber = cleanText(request.data?.senderNumber, 20);
  if (!/^[A-Z0-9-]{6,80}$/.test(transactionId)) {
    throw new HttpsError("invalid-argument", "সঠিক bKash Transaction ID দিন।");
  }
  if (senderNumber && !/^01[3-9]\d{8}$/.test(senderNumber)) {
    throw new HttpsError("invalid-argument", "সঠিক বাংলাদেশি মোবাইল নম্বর দিন।");
  }
  const key = createHash("sha256").update(transactionId).digest("hex");
  const ref = db.collection("proPayments").doc(key);
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) {
      throw new HttpsError("already-exists", "এই Transaction ID আগে জমা দেওয়া হয়েছে।");
    }
    tx.create(ref, {
      uid, transactionId, senderNumber: senderNumber || null,
      amount: PRICE_BDT, currency: "BDT", provider: "bKash",
      status: "pending", requestedAt: FieldValue.serverTimestamp(),
      userEmail: request.auth?.token?.email ?? null
    });
  });
  return { status: "pending", message: "Payment request জমা হয়েছে। Admin যাচাই করার পর Pro চালু হবে।" };
});

export const adminGetOverview = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const [usersSnap, pendingSnap, activeSnap, expiredSnap] = await Promise.all([
    db.collection("users").count().get(),
    db.collection("proPayments").where("status", "==", "pending").count().get(),
    db.collection("users").where("subscriptionTier", "==", "pro").where("subscriptionStatus", "==", "active").count().get(),
    db.collection("users").where("subscriptionStatus", "==", "expired").count().get()
  ]);
  return {
    totalUsers: usersSnap.data().count,
    pendingPayments: pendingSnap.data().count,
    activePro: activeSnap.data().count,
    expiredPro: expiredSnap.data().count
  };
});

export const adminListPayments = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const status = cleanText(request.data?.status, 16);
  const limit = Math.min(Math.max(Number(request.data?.limit) || 50, 1), 100);
  const base = db.collection("proPayments");
  const q = ["pending", "approved", "rejected"].includes(status)
    ? base.where("status", "==", status)
    : base;
  const snap = await q.orderBy("requestedAt", "desc").limit(limit).get();
  return { payments: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

export const adminDecidePayment = onCall({ region: REGION }, async (request) => {
  const adminUid = requireAdmin(request);
  const paymentId = cleanText(request.data?.paymentId, 128);
  const decision = cleanText(request.data?.decision, 16);
  const note = cleanText(request.data?.note, 300);
  if (!paymentId || !["approve", "reject"].includes(decision)) {
    throw new HttpsError("invalid-argument", "Payment ID বা সিদ্ধান্ত সঠিক নয়।");
  }
  const paymentRef = db.collection("proPayments").doc(paymentId);
  await db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw new HttpsError("not-found", "Payment পাওয়া যায়নি।");
    const payment = paymentSnap.data()!;
    if (payment.status !== "pending") throw new HttpsError("failed-precondition", "এই payment আগে process করা হয়েছে।");
    const userRef = db.collection("users").doc(payment.uid);
    const userSnap = await tx.get(userRef);
    const now = Timestamp.now();
    if (decision === "approve") {
      const currentExpiry = userSnap.get("proExpiresAt") as Timestamp | undefined;
      const base = currentExpiry && currentExpiry.toMillis() > now.toMillis() ? currentExpiry.toMillis() : now.toMillis();
      const expires = Timestamp.fromMillis(base + PLAN_DAYS * 24 * 60 * 60 * 1000);
      tx.set(userRef, {
        userId: payment.uid,
        email: payment.userEmail ?? userSnap.get("email") ?? null,
        subscriptionTier: "pro", subscriptionStatus: "active",
        proStartedAt: now, proExpiresAt: expires, updatedAt: now
      }, { merge: true });
      tx.update(paymentRef, {
        status: "approved", reviewedAt: now, reviewedBy: adminUid, adminNote: note,
        activatedUntil: expires
      });
    } else {
      tx.update(paymentRef, { status: "rejected", reviewedAt: now, reviewedBy: adminUid, adminNote: note });
    }
    tx.create(db.collection("adminAuditLogs").doc(), {
      adminUid, action: decision === "approve" ? "approve_payment" : "reject_payment",
      paymentId, targetUid: payment.uid, note, createdAt: now
    });
  });
  return { success: true };
});

export const adminSetPro = onCall({ region: REGION }, async (request) => {
  const adminUid = requireAdmin(request);
  const uid = cleanText(request.data?.uid, 128);
  const action = cleanText(request.data?.action, 16);
  const days = Math.min(Math.max(Number(request.data?.days) || PLAN_DAYS, 1), 3650);
  if (!uid || !["activate", "deactivate"].includes(action)) {
    throw new HttpsError("invalid-argument", "UID বা action সঠিক নয়।");
  }
  const ref = db.collection("users").doc(uid);
  const now = Timestamp.now();
  if (action === "activate") {
    await ref.set({
      userId: uid, subscriptionTier: "pro", subscriptionStatus: "active",
      proStartedAt: now, proExpiresAt: Timestamp.fromMillis(now.toMillis() + days * 86400000),
      updatedAt: now
    }, { merge: true });
  } else {
    await ref.set({
      subscriptionTier: "free", subscriptionStatus: "none",
      proExpiresAt: FieldValue.delete(), updatedAt: now
    }, { merge: true });
  }
  await db.collection("adminAuditLogs").add({
    adminUid, action: `manual_${action}_pro`, targetUid: uid, days, createdAt: now
  });
  return { success: true };
});

export const adminSearchUsers = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const query = cleanText(request.data?.query, 160).toLowerCase();
  if (query.length < 3) throw new HttpsError("invalid-argument", "কমপক্ষে ৩ অক্ষর লিখুন।");
  // Firestore has no case-insensitive contains query. This bounded scan is for a small initial app.
  const snap = await db.collection("users").limit(500).get();
  const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
    .filter((u: any) => String(u.email ?? "").toLowerCase().includes(query) || u.uid.includes(query))
    .slice(0, 30);
  return { users };
});

export const expireProSubscriptions = onSchedule({ schedule: "every day 02:15", timeZone: "Asia/Dhaka", region: REGION }, async () => {
  const now = Timestamp.now();
  while (true) {
    const snap = await db.collection("users")
      .where("subscriptionTier", "==", "pro")
      .where("subscriptionStatus", "==", "active")
      .where("proExpiresAt", "<=", now).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.update(doc.ref, {
      subscriptionTier: "free", subscriptionStatus: "expired", updatedAt: now
    }));
    await batch.commit();
    if (snap.size < 400) break;
  }
});
