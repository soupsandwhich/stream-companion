SOUND FILES FOR STREAM COMPANION
=================================

Place your sound files (.mp3, .wav, .ogg) in this folder.

DEFAULT ALERT SOUNDS:
- follow.mp3      - Plays when someone follows
- subscribe.mp3   - Plays when someone subscribes
- raid.mp3        - Plays when someone raids
- cheer.mp3       - Plays when someone cheers bits
- gift.mp3        - Plays when someone gifts subs
- alert.mp3       - Default fallback sound

CUSTOM SOUNDS (for Stream Deck / Chat Commands):
- Add any sound file here (e.g., airhorn.mp3, tada.mp3)
- Trigger via Stream Deck: POST http://localhost:8877/api/trigger/sound
  Body: { "sound": "airhorn.mp3" }
- Trigger via chat: !sound airhorn (mods only by default)

STREAM DECK SETUP:
1. Add a "Website" action in Stream Deck
2. Set URL to: http://localhost:8877/api/trigger/sound
3. Set Method to: POST
4. Set Body to: {"sound":"yourfile.mp3"}
5. Set Content-Type header to: application/json
