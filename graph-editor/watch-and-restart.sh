#!/bin/bash

# Kill any existing Vite process
pkill -f "vite"

# Start Vite in background
npm run dev &
VITE_PID=$!

# Watch for file changes and restart Vite
while true; do
    # Watch for changes in src directory
    inotifywait -r -e modify,create,delete /home/gjbm2/dev/dagnet/graph-editor/src/ 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "File change detected, restarting Vite..."
        kill $VITE_PID 2>/dev/null
        sleep 1
        npm run dev &
        VITE_PID=$!
    fi
done



