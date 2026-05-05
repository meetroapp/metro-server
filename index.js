const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Meetro API running 🚀" });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log("Server running on port 3000");
});
