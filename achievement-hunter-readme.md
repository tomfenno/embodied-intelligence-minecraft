## Experiment Setup
### settings.js
- "allow_insecure_coding": true,
- "base_profile": "survival"
- 'allow_vision':
      false,  // allows vision model to interpret screenshots as inputs

### Start Up the Game
- Start a Minecraft world using the seed `5383374695217361134` and set lan port to `55916`
- to start the agent run 
 	```bash
	docker-compose up --build
	```
- [Open Mindserver](http://localhost:8080)

#### Spectator Mode 
```bash
# In minecraft
/gamemode spectator
/spectate andy
```

## Experiment Procedure  

set time to sun rise,
```bash
/time set 0 # in minecraft
```


To shutdown the agent run,
```bash
docker-compose down
```