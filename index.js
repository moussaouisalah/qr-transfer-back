const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");
const uuidv4 = require("uuid").v4;
const fs = require("fs");
const getDirName = require("path").dirname;
const multer = require("multer");

const app = express();
app.use(cors());
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
const upload = multer({ storage: storage });

// clear uploads folder on server start
if (fs.existsSync("./uploads")) {
  fs.rmdirSync("./uploads", { recursive: true });
  fs.mkdirSync("./uploads");
}

app.use("/uploads", express.static("uploads"));

app.post("/upload/:roomId", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).send("No file uploaded.");
    return;
  }
  rooms[req.params.roomId].files.push({ path: req.file.path });
  io.to(req.params.roomId).emit("file-upload", { path: req.file.path });
  console.log("file upload", req.file.path);
  console.log(req.params);
  res.status(200).send({ status: "success" });
});

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
    rooms[roomId].users = rooms[roomId].users.filter((s) => s !== username);
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
  let roomId = socket.handshake.query.roomId;
  const username = socket.handshake.query.username;

  if (!username) {
    socket.disconnect();
    return;
  }

  if (!roomId) {
    roomId = uuidv4();
  }

  if (!rooms[roomId]) {
    rooms[roomId] = {
      files: [],
      users: [],
    };
    fs.mkdirSync(`./uploads/${roomId}`, { recursive: true });
  }

  if (rooms[roomId].users.includes(username)) {
    socket.emit("username-taken");
    socket.disconnect();
    return;
  }

  console.log("new connection to room", roomId, "from", username);

  rooms[roomId].users.push(username);
  io.to(roomId).emit("new-user", username);
  socket.join(roomId);
  socket.emit("room-data", { id: roomId, files: rooms[roomId].files, users: rooms[roomId].users });
  registerListeners(socket, { roomId, username });
});

server.listen(4000);
