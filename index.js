require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("civicFixDB");
    const issuesCollection = db.collection("issues");
    const usersCollection = db.collection("users");
    const timelineCollection = db.collection("issuesTimeline");

    // Users data related APIs
    // save all users data in db
    app.post("/api/user", async (req, res) => {
      const userData = req.body;
      const email = userData.email;
      try {
        const isExist = await usersCollection.findOne({ email });
        if (isExist) {
          return res.send({ message: "User already exists." });
        }
        const result = await usersCollection.insertOne(userData);
        res.send(result);
      } catch (error) {
        console.log(error);
        res.json({ message: "something went wrong" });
      }
    });

    // get all users data from db
    app.get("/api/users", async (req, res) => {
      try {
        const { email, role } = req.query;
        const query = {};
        if (email) {
          query.email = email;
        }
        if (role) {
          query.role = role;
        }
        const result = await usersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.log("get user error: ", error);
        res.json({ message: "failed to fetch users" });
      }
    });

    // update staff data by admin
    app.patch("/api/staff/:id/update", async (req, res) => {
      try {
        const { id } = req.params;
        const { name, phone, image } = req.body;

        const updateStaffData = await usersCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              name,
              phone,
              image,
            },
          }
        );

        res.json({ message: "Staff data successfully updated." });
      } catch (error) {
        console.log("Update staff data problem: ", error);

        res.status(400).json({ message: "Failed update staff data." });
      }
    });

    // delete staff by admin
    app.delete("/api/staff/:id/delete", async (req, res) => {
      try {
        const { id } = req.params;
        const deleteStaff = await usersCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.status(200).json({ message: "Staff delete successful." });
      } catch (error) {
        console.log("Staff delete error:", error);
        res.status(400).json({ message: "Failed staff delete." });
      }
    });

    // admin block user & update user data
    app.patch("/api/user/:id/block", async (req, res) => {
      const { id } = req.params;
      try {
        const user = await usersCollection.findOne({ _id: new ObjectId(id) });
        if (!user) return res.status(404).json({ message: "User not found" });

        // Toggle block status
        const updatedUser = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isBlocked: !user.isBlocked } }
        );

        res.json({
          message: `User ${
            user.isBlocked ? "unblocked" : "blocked"
          } successfully`,
          isBlocked: !user.isBlocked,
        });
      } catch (error) {
        console.log(error);
        res.json({ message: "Something went wrong!" });
      }
    });

    // Issues data related APIs
    // Save a Issues data in db
    app.post("/api/report-issue", async (req, res) => {
      try {
        const issueData = req.body;

        if (!issueData) {
          return res.status(400).json({ message: "Issue data is required!" });
        }

        const issue = await issuesCollection.insertOne(issueData);

        const issueTimeline = {
          issueId: issue.insertedId,
          status: "Pending",
          message: "issue reported by citizen.",
          updatedBy: "citizen",
          createAt: new Date(),
        };
        const createIssueTimeline = await timelineCollection.insertOne(
          issueTimeline
        );

        const issueSendBy = issueData.issueBy;
        const query = { email: issueSendBy };
        const update = {
          $inc: {
            totalIssues: 1,
          },
        };
        const updateUserData = await usersCollection.updateOne(query, update);

        res.json({ message: "Report an issue send successful." });
      } catch (error) {
        console.log("report issue error: ", error);
        res.json({ message: "Failed to report an issue!" });
      }
    });

    // get all issues from db
    app.get("/api/all-issues", async (req, res) => {
      try {
        const { email, status, category } = req.query;

        const query = {};

        // user-specific issues
        if (email) {
          query.issueBy = email;
        }

        // optional filters
        if (status && status !== "All") {
          query.status = status;
        }

        if (category && category !== "All") {
          query.category = category;
        }
        const result = await issuesCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.log(error);

        res.json({ message: "Failed to fetch issues" });
      }
    });

    // admin assigned issue to staff
    app.patch("/api/issues/:id/assign", async (req, res) => {
      try {
        const issueId = req.params.id;
        const { staffEmail, staffName } = req.body;

        // prevent re-assign
        const issue = await issuesCollection.findOne({
          _id: new ObjectId(issueId),
        });

        if (issue.assignedStaff) {
          return res.status(400).send({ message: "Staff already assigned" });
        }

        const result = await issuesCollection.updateOne(
          { _id: new ObjectId(issueId) },
          {
            $set: {
              assignedStaff: staffName,
              assignedStaffEmail: staffEmail,
            },
          }
        );

        const updateTimeLine = await timelineCollection.insertOne({
          issueId,
          status: "Pending",
          message: "Issue assigned to staff",
          updatedBy: "admin",
          createdAt: new Date(),
        });

        res.send({ success: true });
      } catch (error) {
        console.log("Assigned issue to staff error:", error);

        res.json({ message: "Failed to assigned staff" });
      }
    });

    // admin reject issue
    app.patch("/api/issues/:id/reject", async (req, res) => {
      try {
        const { id } = req.params;
        const updateIssue = await issuesCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "Rejected",
            },
          }
        );

        const updateTimeLine = await timelineCollection.insertOne({
          issueId: id,
          status: "Rejected",
          message: "Issue rejected by admin",
          updatedBy: "admin",
          createdAt: new Date(),
        });

        res.send({ message: "Issue rejected successfully" });
      } catch (error) {
        console.log("Issue rejected error:", error);

        res.json({ message: "Issue rejected failed!!" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
