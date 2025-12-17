require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
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
    const paymentsCollection = db.collection("payments");

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
        res.status(200).json({ message: "Staff delete successful.---" });
      } catch (error) {
        console.log("Staff delete error:", error);
        res.status(400).json({ message: "Failed staff delete." });
      }
    });

    // update personal info staff (name, image) & admin & citizen
    app.patch("/api/user/:id/update", async (req, res) => {
      try {
        const { id } = req.params;
        const { name, image } = req.body;

        const updateAdminData = await usersCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              name,
              image,
            },
          }
        );

        res.json({ message: "Admin data successfully updated." });
      } catch (error) {
        console.log("Update Admin data problem: ", error);

        res.status(400).json({ message: "Failed update admin data." });
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
          issueId: issue.insertedId.toString(),
          status: "Pending",
          message: "Issue reported by citizen.",
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
        const { email, status, category, assignedStaffEmail, priority } =
          req.query;

        const query = {};

        // user-specific issues
        if (email) {
          query.issueBy = email;
        }

        if (assignedStaffEmail) {
          query.assignedStaffEmail = assignedStaffEmail;
        }

        // 3priority filter using isBoosted
        if (priority === "High") {
          query.isBoosted = true; // High = true
        }

        if (priority === "Normal") {
          query.isBoosted = false; // Normal = false
        }

        // optional filters
        if (status && status !== "All") {
          query.status = status;
        }

        if (category && category !== "All") {
          query.category = category;
        }
        const result = await issuesCollection
          .find(query)
          .sort({ isBoosted: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        console.log(error);

        res.json({ message: "Failed to fetch issues" });
      }
    });

    // get single issue by issue id
    app.get("/api/issue/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await issuesCollection.findOne({
          _id: new ObjectId(id),
        });

        const timeLine = await timelineCollection
          .find({ issueId: id })
          .sort({ createAt: -1 })
          .toArray();

        res
          .status(200)
          .json({ message: "Data fetching successful.", result, timeLine });
      } catch (error) {
        console.log("fetching single issue problem: ", error);

        res.json({ message: "Failed to get issue data." });
      }
    });

    // issue update by user
    app.patch("/api/issue/:id/update", async (req, res) => {
      try {
        const { id } = req.params;
        const { title, description, category, image, location } = req.body;
        const result = await issuesCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              title,
              description,
              category,
              image,
              location,
            },
          }
        );

        res.json({ message: "Issue update successful." });
      } catch (error) {
        console.log("Issue updated error: ", error);

        res.json({ message: "Issue update failed." });
      }
    });

    // upvote by user
    app.patch("/api/issue/:id/upvote", async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        // check issue
        const issue = await issuesCollection.findOne({
          _id: new ObjectId(id),
        });

        // already upvoted
        if (issue.upVotedBy?.includes(userEmail)) {
          return res.status(400).json({
            message: "You have already upvoted this issue",
          });
        }

        // first time upvote
        await issuesCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { upVotes: 1 },
            $addToSet: { upVotedBy: userEmail },
          }
        );

        res.json({ message: "Upvote successful" });
      } catch (error) {
        console.log("Upvote error:", error);
        res.status(500).json({ message: "Upvote failed" });
      }
    });

    // change issue status by staff
    app.patch("/api/issues/:id/status", async (req, res) => {
      try {
        const issueId = req.params.id;
        const { newStatus, changedBy } = req.body;

        const issue = await issuesCollection.findOne({
          _id: new ObjectId(issueId),
        });

        const validFlow = {
          Pending: ["In-progress"],
          "In-progress": ["Working"],
          Working: ["Resolved"],
          Resolved: ["Closed"],
        };

        const STATUS_MESSAGES = {
          "In-progress": "Work started on the issue",
          Working: "Work is actively being done on the issue",
          Resolved: "Issue marked as resolved",
          Closed: "Issue closed by staff",
        };

        if (!validFlow[issue.status]?.includes(newStatus)) {
          return res.status(400).send({ message: "Invalid status change" });
        }

        const statusMessage =
          STATUS_MESSAGES[newStatus] || `Status changed to ${newStatus}`;

        const updateResult = await issuesCollection.updateOne(
          { _id: new ObjectId(issueId) },
          {
            $set: { status: newStatus },
          }
        );

        const issueTimeline = {
          issueId,
          status: newStatus,
          message: statusMessage,
          updatedBy: changedBy,
          createAt: new Date(),
        };
        const createIssueTimeline = await timelineCollection.insertOne(
          issueTimeline
        );

        res.send({
          success: true,
          newStatus,
          message: statusMessage,
        });
      } catch (error) {
        console.log("Issue status changing error:", error);
        res.json({ message: "Issue status changing error." });
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
          createAt: new Date(),
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

    // user delete issue
    app.delete("/api/issue/:id/delete", async (req, res) => {
      try {
        const { id } = req.params;
        const { email } = req.body;

        const updateUser = await usersCollection.updateOne(
          { email },
          {
            $inc: {
              totalIssues: -1,
            },
          }
        );

        const result = await issuesCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.json({ message: "Issue delete successful." });
      } catch (error) {
        console.log("Issue delete error: ", error);

        res.json({ message: "Issue delete failed." });
      }
    });

    // all payments
    // subscription Payment endpoints
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Subscription",
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.email,
        mode: "payment",
        metadata: {
          userId: paymentInfo?.userId,
          userEmail: paymentInfo?.email,
          userName: paymentInfo?.name,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/profile`,
      });
      res.send({ url: session.url });
    });

    // subscription payment success
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const updateUser = await usersCollection.updateOne(
          { _id: new ObjectId(session.metadata.userId) },
          {
            $set: {
              isPremium: true,
            },
          }
        );

        const query = { transactionId: session.payment_intent };
        const isExist = await paymentsCollection.findOne(query);

        if (isExist) {
          return res.json({ message: "Already exists.", transactionId });
        }

        const createPaymentCollection = await paymentsCollection.insertOne({
          userId: session.metadata.userId,
          name: session.metadata.userName,
          email: session.metadata.userEmail,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          createAt: new Date().toLocaleString(),
          paymentType: "Subscription",
          quantity: 1,
        });

        res.send(updateUser);
      } catch (error) {
        console.log("payment success error: ", error);
        res.json({ message: "payment success error" });
      }
    });

    // Issue boost Payment endpoints
    app.post("/create-issue-boost-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Boost issue for: ${paymentInfo.issueTitle}`,
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.issueBoostedBy,
        mode: "payment",
        metadata: {
          issueId: paymentInfo?.issueId,
          issueTitle: paymentInfo?.issueTitle,
          issueReportedBy: paymentInfo?.issueReportedBy,
          issueBoostedBy: paymentInfo?.issueBoostedBy,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/issue-boost-payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/issue-details/${paymentInfo.issueId}`,
      });
      res.send({ url: session.url });
    });

    // issue boost payment success
    app.post("/issue-boost-payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const updateUser = await issuesCollection.updateOne(
          { _id: new ObjectId(session.metadata.issueId) },
          {
            $set: {
              isBoosted: true,
            },
          }
        );

        const query = { transactionId: session.payment_intent };
        const isExist = await paymentsCollection.findOne(query);

        if (isExist) {
          return res.json({ message: "Already exists.", transactionId });
        }

        const createPaymentCollection = await paymentsCollection.insertOne({
          issueId: session.metadata.issueId,
          issueTitle: session.metadata.issueTitle,
          issueReportedBy: session.metadata.issueReportedBy,
          issueBoostedBy: session.metadata.issueBoostedBy,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          createAt: new Date().toLocaleString(),
          paymentType: "Boost Issue",
          quantity: 1,
        });

        const updateTimeLine = await timelineCollection.insertOne({
          issueId: session.metadata.issueId,
          status: "Boosted",
          message: "Issue boost by citizen.",
          updatedBy: "citizen",
          createAt: new Date(),
        });

        res.status(200).json({ message: "Issue boost successful." });
      } catch (error) {
        console.log("Issue boost payment success error: ", error);
        res.json({ message: "Issue boost payment success error" });
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
