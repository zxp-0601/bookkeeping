#!/bin/bash
kill -9 $(lsof -ti :18765) 2>/dev/null
sleep 1
cd "$(dirname "$0")"
node app.js
