-- accta launcher
-- Starts the FastAPI backend and Vite frontend in two Terminal tabs,
-- waits briefly, then opens the browser.

set repoPath to "/Users/rubenmora/Documents/acct"
set frontendPath to repoPath & "/frontend"

tell application "Terminal"
    activate

    -- Backend tab
    set backendTab to do script "cd " & quoted form of repoPath & " && source .venv/bin/activate && uvicorn accta.api.main:app --reload --port 8000"
    set custom title of backendTab to "accta · backend"

    delay 2

    -- Frontend tab (open as new tab in front Terminal window)
    tell application "System Events" to keystroke "t" using {command down}
    delay 0.5
    set frontendTab to do script "cd " & quoted form of frontendPath & " && npm run dev" in front window
    set custom title of frontendTab to "accta · frontend"
end tell

-- Give servers a moment to start before opening the browser
delay 4
do shell script "open 'http://localhost:5173'"
