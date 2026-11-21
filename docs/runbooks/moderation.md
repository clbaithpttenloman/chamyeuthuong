# Gift Moderation Runbook — Noel 2026 (10/12–24/12)

**For:** On-call admins (non-developers welcome). On shift during the Noel event to review reported gifts, ban users, and manage the public queue.

**Language:** Vietnamese UI labels are shown as they appear in the app.

---

## Overview

**The Queue:** Gifts that are awaiting admin review.

- **Bị báo cáo** (Reported) — gifts with 1–2 unacknowledged reports from distinct users
- **Đã ẩn** (Hidden) — gifts that have been reported 3+ times (auto-hidden) or admin-hidden

**Auto-hide:** When a gift receives its 3rd distinct report from a different user (same day, Asia/Ho_Chi_Minh timezone), the gift is automatically hidden and moves to the queue. Reports from banned users or accounts younger than 24 hours are not counted toward the threshold.

**Daily cap:** Each player can report up to 10 gifts per day (resets at midnight Vietnam time).

---

## Accessing the Queue

1. Go to `/admin`
2. Click **Kiểm duyệt quà** (Moderation)
3. Choose a tab:
   - **Bị báo cáo** — gifts with active reports
   - **Đã ẩn** — already-hidden gifts

Each gift card shows:
- Sender nickname · class (or "Một bạn học sinh" if anonymous)
- Card preview
- Heart count
- Status (Bị báo cáo tự động / Ẩn / Hiển thị)
- Report count and breakdown (e.g., "3 báo cáo: 2 không phù hợp, 1 spam")

---

## Actions & Effects

### Khôi phục (Restore)

**Does:** Mark all existing reports as acknowledged and reset the report count to 0. The gift becomes visible again.

**When:** The content is actually OK and was auto-hidden by noise (duplicate reports, test submissions). Restoring acknowledges that you've seen the reports and decided they were false alarms.

**Effect:** Existing reports are now acknowledged and won't retrigger auto-hide. **New reports can still hide it again** (3 new reports = auto-hide again).

**Time:** Takes effect after ~5 seconds (memo TTL).

---

### Ẩn (Hide)

**Does:** Move the gift to "Đã ẩn" tab. It no longer appears on the tree or leaderboard, but the data stays in D1.

**When:** Content violates community guidelines but shouldn't be permanently deleted (might be recovered later if a mistake, or kept as evidence).

**Effect:** Sender still sees it in "Quà của tôi" as "Ẩn" (they know it's hidden). New reports can't be added to a hidden gift.

**Time:** Takes effect after ~5 seconds (memo TTL).

---

### Xoá (Delete)

**Does:** Permanently remove the gift. Can never be recovered.

**When:** Spam, test data, or confirmed policy violation that should not be recoverable.

**Effect:** Sender sees it gone from "Quà của tôi". Senders who gave hearts to it lose those hearts (counts recalculated).

**Time:** Immediate.

---

### Khoá (Ban User)

**Does:** Locks the user account. Their gifts all hide, their hearts are deleted (counts recalculated on all gifts they had hearted), and they are signed out.

**When:** Persistent abuse, spam, or serious policy violation (sending multiple offensive gifts, harassment).

**Effect:**
- User sees "Tài khoản đã bị khóa" on the next sign-in attempt
- All writes (create gift, give heart, report) fail with 403
- Their visible gifts are hidden with reason "banned"
- Their hearts are removed (gift rankings drop for all recipients)
- Any active sessions are revoked (they are signed out)

**Important:** A banned user **cannot delete their account** while banned (or while any of their gifts are hidden — both prevent deletion to preserve evidence). Admins must unban first, or manually delete the account via SQL.

**Time:** Immediate.

---

### Mở khoá (Unban)

**Does:** Restore user account and their gifts to visible status.

**When:** Ban was a mistake, or the event is over and you're clearing temporary bans.

**Effect:**
- User can sign in again, create gifts, give hearts, report
- Hidden gifts are restored to "visible"
- Hearts are **not** restored (they were deleted and cannot be recovered)
- Any tombstone (created when the user was deleted while banned) is removed so a new sign-in doesn't re-ban

**Time:** Immediate.

---

## Workflows

### Handling a Viral Offensive Gift

1. **Hide first, then ban** (not the other way around)
   - If you ban first, the user's gifts hide automatically but their hearts aren't deleted immediately (async race)
   - If you hide first, you can see the gift and decide whether to ban the user
2. Screenshots are not needed (the gift content is stored in D1)
3. If multiple gifts from one user are offensive: ban the user (hides all)
4. If isolated incident: just hide the gift

---

### Handling Deletion Requests via Email

Player asks: "Please delete my account." (They can also do it in-app via "Quà của tôi" → "Xoá tài khoản", but may email for support.)

**Check in-app first:**
1. Have them sign in to `/noel-2026/` → "Quà của tôi" → "Xoá tài khoản"
2. They'll get an error if they can't self-delete (e.g., "pending_review" — gift awaiting moderation)

**If in-app delete fails:**
- `pending_review` (a gift is hidden or has open reports): review it in **Kiểm duyệt quà** (Khôi phục, Ẩn or Xoá), then ask them to try again.
- They cannot sign in any more, or anything else fails: contact the developer. Requests must be completed within 7 days (privacy rule NFR-6).

**Do not delete accounts with hand-written SQL.** The in-app deletion removes the account's gifts, hearts, reports and sessions and recounts every affected gift in one transaction, and writes a tombstone (an HMAC of the Google id) when the account is banned. That cannot be reproduced safely by hand: D1 has no `HMAC()` and no explicit transactions, and a missed recount leaves wrong heart and report counts on other students' gifts.

---

## Tombstone List

Players deleted while banned stay banned on any future sign-in with the same Google account (banned_identity = HMAC of their google_sub, kept indefinitely during the event).

**To see tombstones:**
1. In `/admin` → **Kiểm duyệt quà**, section **Tài khoản đã xoá bị khoá**
2. Shows: creation date only (no email, no name)
3. **Gỡ khóa** (Delete tombstone): Removes the ban-on-sign-in record. The Google sub is no longer banned if that account signs in again.

---

## What Admins Cannot See

- **Reporter identities:** You see report counts and reasons (inappropriate, spam, other) but never the name or email of who reported it
- **Exact timestamps of reports:** You see the total count, not when each report arrived (helps preserve privacy)
- **IP addresses or user agents:** No analytics data about where reports came from

---

## Caching & Delays

**Tree updates every 5 seconds** (memoised in the Worker per isolate). When you restore or hide a gift:
1. Write happens immediately (DB)
2. Updated status reaches the tree endpoint after up to 5 seconds
3. Players' clients poll every 15 seconds (± 3 s jitter)

**Real-world delay:** 0–5 s (write to cache update) + 0–15 s (next poll) = up to ~20 seconds before all players see the change.

Heart counts are recalculated synchronously so they're consistent immediately after a ban/unban.

---

## Tips

1. **Check the time:** Reports reset at midnight Vietnam time (UTC+7). If you're checking at 23:50 UTC (06:50 UTC+7), daily caps will refresh soon.
2. **Read report reasons:** Filter by the reason (không phù hợp = inappropriate, spam = spam, other = other) to spot patterns (all spam = likely bot, all inappropriate = targeted harassment).
3. **Respond within 2 hours** during event hours. The longer inappropriate content stays public, the worse the experience for others.
4. **Screenshot feedback:** If you find yourself needing to explain a decision to the team, screenshots of the card (in-app) are easier than SQL queries.
5. **Escalate:** If you're unsure whether to ban or hide, ask another admin or the dev team; it's better to wait 15 minutes than to permanently ban the wrong person.

---

## Troubleshooting

**Q: A gift is still showing on the tree even though I hid it.**
A: Wait 5 seconds for the memo to refresh. If it's still visible after 10 seconds, reload your browser cache with Ctrl+Shift+R (or report to dev).

**Q: I can't find a gift by nickname.**
A: Gifts are listed by status (Bị báo cáo / Đã ẩn); there's no search. Scroll through the list or ask for the gift's public ID (first 16 chars).

**Q: Ban option is grayed out.**
A: The user might already be banned. Check the "Khoá" status.

**Q: A deleted account is still signing back in.**
A: They were deleted while NOT banned, so no tombstone. Ask them to contact support or re-ban them if they're a repeat offender.

