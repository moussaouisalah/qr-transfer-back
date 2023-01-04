const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");
const uuidv4 = require("uuid").v4;
const fs = require("fs");
const getDirName = require("path").dirname;
const multer = require("multer");
const bodyParser = require("body-parser");

const generateRandomIdNoCollision = (existingIds) => {
  let id = "";
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ"; // no I, O, or Q to avoid confusion
  do {
    id = "";
    for (let i = 0; i < 4; i++) {
      id += letters[Math.floor(Math.random() * letters.length)];
    }
  } while (existingIds.includes(id));
  return id;
};

const app = express();
app.use(cors());
app.use(bodyParser.json());
const server = http.createServer(app);
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // get room id from request path param
    const roomId = req.params.roomId;
    // check if room exists
    if (!rooms[roomId]) {
      return cb(new Error("Room does not exist"));
    }
    // create room uploads folder if it doesn't exist
    if (!fs.existsSync(`./uploads/${roomId}`)) {
      fs.mkdirSync(`./uploads/${roomId}`, { recursive: true });
    }
    cb(null, `./uploads/${roomId}`);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage, limits: { fileSize: 50_000_000 } }); // max size of 50MB

// clear uploads folder on server start
if (fs.existsSync("./uploads")) {
  fs.rmdirSync("./uploads", { recursive: true });
  fs.mkdirSync("./uploads");
}

app.use("/uploads", express.static("uploads"));

app.post(
  "/upload/:roomId",
  (req, res, next) => {
    // check user upload token
    const uploadToken = req.query.token;
    if (!uploadToken) {
      res.status(401).send({ status: "failed", message: "no upload token" });
      return;
    }
    // get room id from request path param
    const roomId = req.params.roomId;
    // check if room exists
    if (!rooms[roomId]) {
      res.status(400).send({ status: "failed", message: "room doesn't exist" });
      return;
    }
    const user = rooms[roomId].users.filter((user) => user.uploadToken === uploadToken)?.[0];
    if (!user) {
      res.status(401).send({ status: "failed", message: "invalid upload token" });
      return;
    }
    // set username in request
    req.uploader = user.username;
    next();
  },
  upload.single("file"),
  (req, res) => {
    if (!req.file) {
      res.status(400).send("No file uploaded.");
      return;
    }
    const uploader = req.uploader;
    rooms[req.params.roomId].files.push({
      name: req.file.originalname,
      path: req.file.path,
      uploader,
    });
    io.to(req.params.roomId).emit("file-upload", {
      name: req.file.originalname,
      path: req.file.path,
      uploader,
    });
    console.log("file upload", req.file.path);
    console.log(req.params);
    res.status(200).send({ status: "success" });
  }
);

const io = new socketIO.Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {};

function writeFile(path, contents, cb) {
  fs.mkdir(getDirName(path), { recursive: true }, function (err) {
    if (err) return cb(err);

    fs.writeFile(path, contents, cb);
  });
}

const registerListeners = (socket, { roomId, username }) => {
  socket.on("disconnect", () => {
    console.log("disconnect");
    rooms[roomId].users = rooms[roomId].users.filter((s) => s.username !== username);
    socket.broadcast.emit("user-disconnected", username);
    // check if room is empty and delete it
    if (rooms[roomId].users.length === 0) {
      console.log("deleting room", roomId);
      delete rooms[roomId];
      // clear room uploads folder
      fs.rmdirSync(`./uploads/${roomId}`, { recursive: true });
    }
  });
};

io.on("connection", (socket) => {
  const roomId = socket.handshake.query.roomId;
  const connectionCode = socket.handshake.query.connectionCode;

  if (!roomId || !connectionCode || !rooms[roomId]) {
    socket.disconnect();
    return;
  }

  const connectionData = rooms[roomId].connectionCodes.find(
    (info) => info.connectionCode === connectionCode
  );
  if (!connectionData) {
    socket.disconnect();
    return;
  }

  const username = connectionData.username;

  rooms[roomId].connectionCodes = rooms[roomId].connectionCodes.filter(
    (info) => info.code !== connectionCode
  );

  const userUploadToken = uuidv4();
  rooms[roomId].users.push({ username, uploadToken: userUploadToken });
  io.to(roomId).emit("new-user", username);
  socket.join(roomId);
  socket.emit("room-data", {
    id: roomId,
    files: rooms[roomId].files,
    users: rooms[roomId].users.map((user) => user.username),
    uploadToken: userUploadToken,
    username,
  });
  registerListeners(socket, { roomId, username });
});

app.get("/", (req, res) => {
  res.send("Hello 🤩");
});

app.post("/rooms/new", (req, res) => {
  const username = req.body.username;
  if (!username) {
    res.status(400).send({ status: "failed", message: "no username provided" });
    return;
  }
  const newRoomId = generateRandomIdNoCollision(Object.keys(rooms));
  rooms[newRoomId] = {
    files: [],
    users: [],
    connectionCodes: [],
  };
  fs.mkdirSync(`./uploads/${newRoomId}`, { recursive: true });

  const userConnectionCode = uuidv4();
  rooms[newRoomId].connectionCodes = [{ username, connectionCode: userConnectionCode }];
  res
    .status(200)
    .send({ status: "success", roomId: newRoomId, connectionCode: userConnectionCode });
});

app.post("/rooms/join", (req, res) => {
  const roomId = req.body.roomId;
  const username = req.body.username;
  if (!roomId || !username) {
    res.status(400).send({ status: "failed", message: "no roomId or username provided" });
    return;
  }
  if (!rooms[roomId]) {
    res.status(400).send({ status: "failed", message: "room doesn't exist" });
    return;
  }
  if (rooms[roomId].users.map((user) => user.username).includes(username)) {
    res.status(400).send({ status: "failed", message: "username already taken" });
    return;
  }
  const userConnectionCode = uuidv4();
  rooms[roomId].connectionCodes.push({ username, connectionCode: userConnectionCode });
  res.status(200).send({ status: "success", roomId, connectionCode: userConnectionCode });
});

server.listen(4000, () => console.log("server is running on port 4000 🚀"));
