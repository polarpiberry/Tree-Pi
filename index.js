const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const https = require("https");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { exec } = require("child_process");

const app = express(); //Main web server
const httpApp = express(); //HTTP app for redirecting

//Web ports to use
const HTTPS_PORT = 443;
const HTTP_PORT = 80;



let config = require("./config.json"); //Config file for max/min values


let dataLog = require("./dataLog.json"); //Log for timestamp/level measurements

let readingFlag = false; //Reading flag to prevent concurrent reading of measuring stick
let ledsOnFlag = false; //LEDs on flag to prevent concurrent running on LED mode

let transporter = nodemailer.createTransport({ //Email transporter
	host: "smtp.gmail.com",
	port: 587,
	secure: false,
	auth: {
		user: config.googleEmail,
		pass: config.googlePswd,
	},
});

let emailMessage = { //Default email message
	from: config.fromEmail,
	to: config.toEmail,
	priority: "high",
	subject: "TreePi: Tree Low on Water!",
	html: "<h1>The tree is low on water! Please fill it up soon or check on the level at <a href='https://treepi.home'>treepi.home</a>.</h1>"
}

let sslOpts = { //SSL for PWA installation
	key: fs.readFileSync("./ssl/treepi.key"),
	cert: fs.readFileSync("./ssl/treepi.crt"),
}

// Change the config file for min/max
const setConfig = (config) => {
	fs.writeFileSync("config.json", JSON.stringify(config));
}

// Add a data entry to dataLog
const addDataEntry = (dataEntry) => {
	dataLog.arr.push(dataEntry);
	fs.writeFileSync("dataLog.json", JSON.stringify(dataLog));
}


/**
 * Get the current level (0-13)
 * @async
 * @returns {number} Current level
 */
const getCurrentLevel = () => {
	return new Promise((resolve, reject) => {
		if (readingFlag) {
			setTimeout(() => resolve(getCurrentLevel()), 250); //Delay for 250ms and try again
			return;
		}
		readingFlag = true;
		exec("./scripts/read-level", (err, stdout, stderr) => {
			readingFlag = false;
			if (err) {
				console.log("Error! ", err);
				reject(err);
				return;
			}
			resolve(parseInt(stdout));
		});
	});
}

/**
 * Run a loop until timeout for filling up the tree (shows LEDs with current water level)
 * @param {number} timeout Timeout in ms
 * @async
 */
const fillingMode = async (timeout) => {
	if (ledOnMode) return
	ledOnMode = true;
	return new Promise((resolve, reject) => {
		exec(`./scripts/level-led-monitor ${timeout} ${config.min} ${config.max}`, (err, stdout, stderr) => {
			ledOnMode = false;
			if (err) {
				console.log("Error! ", err);
				reject(err);
				return;
			}
			console.log(stdout);
			console.log("Filling mode completed");
			resolve();
		});
	});
}



//Routes on HTTPS server
app.use(express.static("public")); //Serve static files such as index.html
app.use(bodyParser.json()); //Read JSON from requests

app.post("/getcurrent", async (req, res) => {
	let level = await getCurrentLevel();
	if (level > config.max) { //Reset max level if higher than current
		config.max = level;
		console.log("Updated maximum level to", level);
		setConfig(config);
	}
	let percent = 100*(level-config.min)/(config.max-config.min);
	console.log(`Request for current level. Read at ${percent}%`);
	res.send(JSON.stringify({
		success: percent >= 0 && percent <= 100,
		currentLevel: percent
	}));
});

app.post("/getdata", async (req, res) => { //Return the data for a given number of hours back
	let hours_back = (req.body && req.body.hours_back) || 24; //Default to 24 hours back
	console.log(`Request for data with a requested amount of ${hours_back} hours back`);
	let minTime = new Date().valueOf() - (hours_back * 60 * 60 * 1000); //Current millis time minus amount of hours back
	let data = dataLog.arr.filter((obj) => obj[0] > minTime);
	console.log(data);
	res.send(JSON.stringify({
		success: true,
		arr: data
	}));
});


app.post("/getsettings", async (req, res) => { //Return the min and max from config
	console.log("Request for settings");
	res.send(JSON.stringify({
		success: true,
		settings: {
			min: config.min,
			max: config.max
		}
	}));
});

app.post("/setsettings", async (req, res) => { //Update the min and max in config
	console.log("Update settings to: ", req.body);
	let status = { success: true };
	let min = parseInt(req.body.min);
	let max = parseInt(req.body.max);
	if (!isNaN(min) && !isNaN(max) && min >= 0 && min <= 13 && max >= 1 && max <= 14 && max > min) {
		config.min = req.body.min;
		config.max = req.body.max;
		setConfig(config);
	} else {
		status = { success: false, msg: "Invalid minimum/maximum values or not supplied. Must include parameters min and max, which are between 0 and 13 and 1 and 14, inclusive, respectively, as well as max being greater than min" };
	}
	res.send(JSON.stringify(status));
});

app.post("/shutdown", (req, res) => { //Shutdown the computer (if the passcode is correct)
	console.log("Request for shutdown");
	let passcode = req.body && req.body.pswd; //Passcode
	if (passcode != config.shutdownPswd) {
		res.send(JSON.stringify({
			success: false,
			msg: "Incorect password or parameter not supplied (name: pswd, type: text)"
		}));
		return;
	}
	res.send(JSON.stringify({
		success: true,
	}));
	console.log("Shutting down now...");
	exec("shutdown now -h", (err, stdout, stderr) => {
		if (err) {
			console.log("Error while trying to shutdown ", err);
			return;
		}
	});
});

app.post("/fillingmode", async (req, res) => { //Start filling mode (show lights based on current level) for timeout specified
	let timeout = (req.body && req.body.timeout) || 5; //Default to 5 second timeout
	console.log(`Request for filling mode with timeout of ${timeout} seconds`);
	fillingMode(timeout);
	res.send(JSON.stringify({
		success: true
	}));
});

app.get("/data.json", (req, res) => {
	res.send(JSON.stringify({
		dataLog
	}));
});

//Redirect HTTP to HTTPS server
httpApp.get("*", (req, res) => res.redirect("https://" + req.headers.host + req.url));
httpApp.listen(HTTP_PORT);

https.createServer(sslOpts, app).listen(HTTPS_PORT, () => { //Create HTTPS server
	console.log(`App listening on port ${HTTPS_PORT}`);
});


//Finally, set up automatic data collection and storage into dataLog
setInterval(async () => {
	let level = await getCurrentLevel();
	let currTime = new Date().valueOf();
	addDataEntry([currTime, level]);
}, 15* 60 * 1000); //Add an entry every 15 minutes (15 * 60 * 1000 ms)