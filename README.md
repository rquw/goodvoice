# Choicer Voicer

Recreate iconic movie moments with your own voice. Watch a short clip, match the
character's timing and delivery as closely as possible, and see how your
performance compares.

Solo works fully offline-ish in the browser. Party mode needs this little server.

## what it does

- upload any movie clip (mp4, mov, webm, mkv). every cut becomes its own clip.
  a neural voice detector (Silero VAD) finds which clips have dialogue, and
  you only record those: record, then redo or next. the clips without
  dialogue come back untouched in the final video, so it's the whole upload
  front to back
- subtitles: Whisper runs **in your browser** (transformers.js), no API key.
  the model and runtime are served by this server (from npm), so it doesn't
  depend on Hugging Face or a CDN. karaoke-style while you record, not in the
  final video
- voice removal without AI: film dialogue sits dead center in the stereo mix, so
  the center gets cancelled and music/effects on the sides stay. mono files get
  the speech band notched out instead. or just mute everything
- karaoke-style script, live visualizer (the pale shape is the actor's voice,
  yours fills in over it), 3-2-1 countdown
- scoring like the original: 58% rhythm, 32% duration, 10% coverage, five judges
  hand out 0–5 stars. both the actor's shape and yours only count speech the
  voice detector hears, so music, room noise and speaker bleed don't score
- party mode: room codes, everyone records at the same time, takes get played
  back one by one, judges + audience vote, podium at the end
- when it's done the full dub plays right away: the whole upload, front to back,
  with the voices swapped. in party mode it's the same video on every screen
  and play / pause / seek are shared (anyone can control it, everyone follows)
- the download renders **on the device** (canvas + MediaRecorder, mp4 on
  Chrome/Edge/Safari, webm on Firefox). nothing gets uploaded for that

## run it locally

```bash
npm install
npm start
# open http://localhost:8080
```

The mic only works on `localhost` or HTTPS.

## put it online (Render, free)

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to https://dashboard.render.com → **New** → **Blueprint**.
3. Pick the `goodvoice` repo. Render finds `render.yaml` and sets up a
   web service called `goodvoice`.
4. Click **Apply**. First deploy takes ~2 minutes.
5. Your game lives at `https://goodvoice.onrender.com` (or whatever name
   Render gives it). Send that link to friends. HTTPS is automatic, which the
   mic needs.

Doing it by hand instead of the blueprint: **New → Web Service**, repo `goodvoice`,
Runtime Node, Build `npm install`, Start
`node server.js`, instance type Free.

Free tier notes:
- it falls asleep after 15 min without traffic. first visit after that takes
  ~30–60 s to wake up. that's normal
- uploaded videos live on temporary disk and get deleted when the room closes
  (15 min after everyone leaves) or when the server restarts
- `MAX_UPLOAD_MB` (default 800) caps the host upload size
- bandwidth: guests stream only the parts of the video they need (HTTP range
  requests), takes are ~50 KB opus each, rendering happens on each device
- if the tab gets hidden during a render it pauses and resumes where it was,
  instead of spitting out a frozen/silent file

## how party mode works

```
host uploads video ──► server stores it temporarily (/tmp)
host's browser finds cuts + writes the script, sends clip list (tiny JSON)
guests stream the video from the server with range requests
every clip:   loading → listen → record (everyone at once) → showtime → vote → results
takes (opus, ~50 KB) go up to the server, everyone downloads them for showtime
```

The server is ~500 lines of plain Node + `ws`, no database.

## files

- `server.js` rooms, uploads, range streaming, game state machine
- `public/js/analyze.js` audio decoding, voice envelopes, cut detection, clip grouping
- `public/js/asr.js`, `asr-worker.js` Whisper in a web worker
- `public/js/audio.js` voice remover, mic capture (AudioWorklet), sync
- `public/js/score.js` rhythm / duration / coverage + judges
- `public/js/stage.js` player, karaoke, visualizer, countdown
- `public/js/export.js` client-side video render
- `public/js/codec.js` opus packing for takes (WebCodecs, wav fallback)
- `public/js/studio.js` upload + analysis
- `public/js/app.js` screens, solo + party flow

## tips

- headphones. without them your mic hears the clip and scores get worse
  (echo cancellation helps, it's on by default)
- if your dub plays back early/late, fix it in Settings → Sync offset.
  bluetooth headphones usually want −100 to −250 ms
- the auto script is best in English. set the language in Settings if it guesses wrong
