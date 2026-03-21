## Experiment Setup
### settings.js
- "allow_insecure_coding": true,
- "base_profile": "survival"
- 'allow_vision':
      false,  // allows vision model to interpret screenshots as inputs

### Start Up the Game
- Start a Minecraft world using the seed `-2935794933495005655` and set lan port to `55916`
- to start the agent run 
 	```bash
	docker-compose up --build
	```
- [Open Mindserver](http://localhost:8080)
>**Important!** You will need to give commands through the Mindserver when the agent is in survival mode.

#### Spectator Mode 
```bash
# In minecraft
/gamemode spectator
/spectate andy
/effect give <your name>  minecraft:night_vision infinite 
```
>**Note:** if the agent disconnects you will need to use the command: 
` /spectate andy`
to resume spectating the agent when they reconnect.

This will set your camera to the pov of `andy` and it will give you night vision which comes in handy when the agent goes into a dark cave. When in chat mode you can leave the window without it pausing.

It helps to make the chat screen smaller so you can still see what is happening. 

To do this go to `Options...`->`Chat Settings...` and adjust the `Width:` and `Chat Text Size:`. A good setting for these are,

- `Width: 100px`
- `Chat Text Size: 40%`

## Experiment Procedure  

1. set time to sun rise,
	```bash
	/time set 0 # in minecraft
	```

2. Give the bot the command in the [Mindserver](http://localhost:8080). 


Once the agent is done with its trial, send a final message saying. This trial has ended stay still.

Once the agent has acknowledge this, disconnect the client in the[Mindserver](http://localhost:8080).  

log the raw prompt history by running:
### Logging
> **To Do:** this was my first idea on how to log the trials, but I need to work on it more.
```bash
cat bots/andy/logs/*.txt > achievement_hunter/logs/<agent>_<achievement>_<trial#>.txt 
```

After the prompts have been logged delete the log history with:
```bash
rm -r bots/andy/logs/*
```
## Shutting down the server
To shutdown the server run,
```bash
docker-compose down
```