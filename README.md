# Rider Radio 🏍️📻

A no-login, no-chat PWA where riders join a shared **channel** (room) and get
a live **group voice call** — like a CB radio. Built with:

- **Backend:** Node.js + Express + Socket.IO (signaling only — relays WebRTC
  offers/answers/ICE candidates, no audio ever touches the server)
- **Frontend:** Plain HTML/CSS/JS PWA, installable on mobile, mic + speaker
  auto-enable the moment you tap "Join"
- **Calling:** WebRTC mesh (peer-to-peer audio), so everyone in a channel
  hears everyone else directly

No accounts, no database, no chat box — just a room name and your voice.

---

## 1. Run it locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on your computer. To test with a phone on the
same Wi-Fi, WebRTC's mic permission normally requires HTTPS — `localhost`
is exempt, but a phone hitting your laptop's LAN IP over plain `http://`
will usually be blocked from using the microphone. Easiest path: deploy to
Render (free HTTPS) and test from there, or use a tunnel like `ngrok http
3000` for a quick HTTPS local test.

Open two browser tabs (or a tab + phone) → enter the same channel name in
both → you should hear yourself talk on the other tab.

---

## 2. Deploy to Render

1. Push this project to a GitHub repo.
2. In Render: **New → Web Service** → connect the repo.
3. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start` (or `node server.js`)
   - **Instance Type:** Free is fine to try it out
4. Deploy. Render gives you a `https://your-app.onrender.com` URL —
   HTTPS is required for microphone access on mobile browsers, and Render
   provides this automatically.
5. Open that URL on your phone's mobile browser, type a channel name (e.g.
   your riding crew's name), tap **Key up & join**. Share the exact same
   channel name with the rest of your crew — that's the whole "room".

### Add it to your phone's home screen (PWA install)

- **Android/Chrome:** open the site → menu (⋮) → "Add to Home screen" / you
  may also see an automatic install banner.
- **iPhone/Safari:** open the site → Share icon → "Add to Home Screen".

Once installed it opens full-screen, like a native app, straight to the
channel screen.

---

## 3. How the calling works (mesh, no media server)

- Everyone who joins channel `X` connects to a lightweight Socket.IO
  namespace room called `X`.
- The server **never sees or touches audio** — it only relays small
  signaling messages (SDP offers/answers, ICE candidates) between browsers.
- Each pair of riders opens a direct `RTCPeerConnection` audio stream. With
  `N` riders in a channel there are `N-1` connections per person — this
  mesh approach works great for small crews (a handful of riders). If you
  expect big groups (10+) regularly, you'd want to switch to an SFU
  (e.g. mediasoup/LiveKit) instead of mesh — ask if you'd like that version.

### Autoplay / "hearable on mobile" details

Mobile browsers block audio from playing until the user interacts with the
page. This app handles that by:
1. Requesting the microphone **and** unlocking a silent `AudioContext`
   inside the same tap that submits the "Join" form (that tap counts as
   the required user gesture).
2. Every remote rider's audio is played through an `<audio autoplay
   playsinline>` element created after that unlock — so speaker output
   turns on automatically as soon as someone starts talking, no second tap
   needed.
3. As a safety net, if a browser still blocks a specific stream, the app
   retries `play()` on the very next tap anywhere on the screen.

**Reminder for riders:** the phone's physical ringer/media volume has to be
turned up — no app can override a phone's hardware mute switch.

### TURN server note

The app ships with a free public TURN relay (openrelay/metered.ca) in
`public/app.js` so riders on cellular data / strict NATs can still connect
to each other, not just on the same Wi-Fi. It's fine for testing and small
crews, but is rate-limited. For heavier daily use, sign up for a free tier
at a TURN provider (e.g. metered.ca, Twilio, Cloudflare Calls) and swap the
credentials into the `ICE_SERVERS` array at the top of `public/app.js`.

---

## Project structure

```
rider-radio/
├── server.js              # Express static server + Socket.IO signaling
├── package.json
└── public/                # the PWA
    ├── index.html         # Join screen + Call screen (no chat UI at all)
    ├── style.css
    ├── app.js             # WebRTC mesh, mic/speaker handling, mute/leave
    ├── manifest.json
    ├── sw.js              # offline app-shell caching
    └── icons/icon.svg
```

## Customizing

- **Channel = room name only.** There's no room list/directory by design
  (no accounts). Riders just have to agree on the same channel name (e.g.
  `sunday-cruise`), same as picking a CB channel number.
- **Colors/branding** live in `public/style.css` under `:root`.
- Want push-to-talk instead of always-open mic? The mute button in
  `app.js` (`talkToggle`) is already wired to toggle the mic track — you
  could rebind it to `pointerdown`/`pointerup` for true push-to-talk.
