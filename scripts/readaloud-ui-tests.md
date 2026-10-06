# Read-aloud UI tests

Run the focused browser integration tests from the repository root with the existing FreeMarkdown development app open at `http://127.0.0.1:1420/`. The app must be reachable through the IPv6 CDP endpoint `[::1]:9223`; the runner rejects other page origins and verifies the FreeMarkdown window title and development hooks.

The tests use Node's built-in test runner and the repository's existing `chrome-remote-interface` dependency. They do not launch or stop the app. They use temporary Markdown files under the operating system temp directory, close only those test panels, restore the development profile's saved read-aloud preferences, and leave the app open.

The local ZipVoice model must already be installed. The runner uses `FREEMARKDOWN_TTS_MODEL_DIR` when set, or the model directory already saved in the app's development profile. For example, in PowerShell:

```powershell
$env:FREEMARKDOWN_TTS_MODEL_DIR = 'J:\PigeonYang\FreeMarkdown\.verify\tts\sherpa-onnx-zipvoice-distill-int8-zh-en-emilia'
node --test scripts/readaloud-ui.test.mjs
```

Set `FREEMARKDOWN_READALOUD_TIMEOUT_MS` to change the bounded event and UI wait, in milliseconds. It defaults to 60000 and accepts values from 15000 through 180000. The first native synthesis may take several seconds while the model initializes.

Read-aloud settings live under 设置 → 阅读. Playback controls and the direct “从这里朗读” action remain in the toolbar. The cases use those rendered controls and check the DOM against actual native `readaloud:event` playback events. The toolbar and settings cases reopen their temporary source through the development app hook after returning from settings, because the existing settings page restores the saved panel layout. It does not write that saved session. The runner restores the original settings page, category, follow preference, document, and saved read-aloud preferences. The stale-token case first waits for native playback, stops it through the UI, then sends an explicitly marked old-token event through the app event bus to verify that the stopped UI stays idle. The printed `READALOUD_UI_NATIVE_TRACE` contains only events observed from the native service.

Most cases are post-implementation regression tests. The ZipVoice title and single accepted voice assertion was added first and observed failing against Kokoro before the replacement. The original UI behavior was first exercised by ignored, ephemeral scripts under `.verify/tts`; that earlier integration evidence was not a tracked RED test run, so it does not establish a test-first TDD history. Existing `src/readaloud/*.test.mjs` files cover the playback owner and text parsing separately. These UI tests cover interaction and event wiring, not speech quality or naturalness.



The UI waiter also checks control properties every 50 ms because React can update a select value without a DOM mutation. The speed case changes the rendered select, checks the saved preference, and checks the value after remounting the reading settings pane. The direct-start case scrolls its temporary source to line 3 and requires a native playing event for that line.

Keep source and documentation edits paused during this CDP run. Vite updates can replace the page-side native event subscription and make later event waits fail even while native playback continues. Stop that run, allow the dev page to stabilize, then rerun the focused cases. The suite deadline allows four event-wait budgets plus 30 seconds for the slower ZipVoice engine; individual waits and assertions retain their stated bounds.
