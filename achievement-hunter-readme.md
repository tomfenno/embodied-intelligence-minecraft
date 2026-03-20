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
```

This will set your camera to the pov of `andy`. When in chat mode you can leave the window without it pausing.

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

To shutdown the agent run,
```bash
docker-compose down
```