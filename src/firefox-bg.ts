// Firefox has no chrome.offscreen document API. Its MV3 background scripts
// run in an extension document, so the PeerHub/offscreen runtime and the
// service-worker-style election/lifecycle broker can share this background
// context.
import "./sw.js"
import "./offscreen/offscreen.js"
