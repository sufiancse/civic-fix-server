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
      "https://civicfix-city.web.app",
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
    // console.log(decoded);
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

    // role middlewares
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };
    const verifySTAFF = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "staff")
        return res
          .status(403)
          .send({ message: "Staff only Actions!", role: user?.role });

      next();
    };
    const verifyUSER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "citizen")
        return res
          .status(403)
          .send({ message: "Staff only Actions!", role: user?.role });

      next();
    };

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

        const boosted = await paymentsCollection.findOne({ email });
        res.send({ result, boosted });
      } catch (error) {
        console.log("get user error: ", error);
        res.json({ message: "failed to fetch users" });
      }
    });

    // update staff data by admin
    app.patch(
      "/api/staff/:id/update",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
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
      }
    );

    // delete staff by admin
    app.delete(
      "/api/staff/:id/delete",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
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
      }
    );

    // update personal info staff (name, image) & admin & citizen
    app.patch("/api/user/:id/update", verifyJWT, async (req, res) => {
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
    app.patch(
      "/api/user/:id/block",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
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
      }
    );

    // Issues data related APIs
    // Save a Issues data in db
    app.post("/api/report-issue", verifyJWT, verifyUSER, async (req, res) => {
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
        const {
          email,
          status,
          category,
          assignedStaffEmail,
          priority,
          search,
          page = 1,
          limit = 8,
        } = req.query;

        const query = {};

        if (email) query.issueBy = email;
        if (assignedStaffEmail) query.assignedStaffEmail = assignedStaffEmail;

        if (priority === "High") query.isBoosted = true;
        if (priority === "Normal") query.isBoosted = false;

        if (status && status !== "All") query.status = status;
        if (category && category !== "All") query.category = category;

        if (search) {
          query.$or = [{ title: { $regex: search, $options: "i" } }];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const total = await issuesCollection.countDocuments(query);

        const issues = await issuesCollection
          .find(query)
          .sort({ isBoosted: -1, createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const allIssues = await issuesCollection
          .find()
          .sort({ isBoosted: -1 })
          .toArray();

        res.send({
          issues,
          allIssues,
          total,
          totalPages: Math.ceil(total / limit),
          currentPage: parseInt(page),
        });
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Failed to fetch issues" });
      }
    });

    // get latest resolved issues
    app.get("/api/latest-resolved-issues", async (req, res) => {
      try {
        const latestResolvedIssues = await issuesCollection
          .find({ status: "Resolved" })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        res.send(latestResolvedIssues);
      } catch (error) {
        console.log("Fetch latest resolved issues:", error);

        res.json({
          message: "Failed to fetch latest resolved issues.",
        });
      }
    });

    // get single issue by issue id
    app.get("/api/issue/:id", verifyJWT, async (req, res) => {
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
    app.patch(
      "/api/issue/:id/update",
      verifyJWT,
      verifyUSER,
      async (req, res) => {
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
      }
    );

    // upvote by user
    app.patch("/api/issue/:id/upvote", verifyJWT, async (req, res) => {
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
    app.patch(
      "/api/issues/:id/status",
      verifyJWT,
      verifySTAFF,
      async (req, res) => {
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
      }
    );

    // admin assigned issue to staff
    app.patch(
      "/api/issues/:id/assign",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
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
      }
    );

    // admin reject issue
    app.patch(
      "/api/issues/:id/reject",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
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
      }
    );

    // user delete issue
    app.delete(
      "/api/issue/:id/delete",
      verifyJWT,
      verifyUSER,
      async (req, res) => {
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
      }
    );

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

    // get all payments data
    app.get("/api/payments", verifyJWT, async (req, res) => {
      try {
        const { search = "", type = "all" } = req.query;

        let query = {};

        // 🔍 search by name / email
        if (search) {
          query.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { issueBoostedBy: { $regex: search, $options: "i" } },
          ];
        }

        // 🎯 filter by paymentType
        if (type !== "all") {
          query.paymentType = type;
        }

        const payments = await paymentsCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        res.status(500).send({ message: "Failed to load payments" });
      }
    });

    // user dashboard home
    app.get("/api/user-dashboard", verifyJWT, verifyUSER, async (req, res) => {
      try {
        const { email } = req.query;

        //issues
        const totalIssues = await issuesCollection.countDocuments({
          issueBy: email,
        });

        const pending = await issuesCollection.countDocuments({
          issueBy: email,
          status: "Pending",
        });

        const inProgress = await issuesCollection.countDocuments({
          issueBy: email,
          status: { $in: ["In-progress", "Working"] },
        });

        const resolved = await issuesCollection.countDocuments({
          issueBy: email,
          status: "Resolved",
        });

        // all payments
        const payments = await paymentsCollection
          .find({
            $or: [{ email }, { issueBoostedBy: email }],
          })
          .toArray();

        const totalPaymentAmount = payments.reduce(
          (sum, p) => sum + Number(p.amount || 0),
          0
        );

        res.send({
          stats: {
            totalIssues,
            pending,
            inProgress,
            resolved,
            totalPaymentAmount,
          },
          chart: {
            barData: [
              { name: "Pending", count: pending },
              { name: "In Progress", count: inProgress },
              { name: "Resolved", count: resolved },
            ],
            pieData: [
              { name: "Pending", value: pending, color: "#FACC15" },
              { name: "In Progress", value: inProgress, color: "#8B5CF6" },
              { name: "Resolved", value: resolved, color: "#22C55E" },
            ],
          },
        });
      } catch (error) {
        console.log("Dashboard error:", error);
        res.status(500).send({ message: "Failed to load dashboard data" });
      }
    });

    // admin dashboard home
    app.get(
      "/api/admin-dashboard",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        try {
          // ===== USERS =====
          const totalUsers = await usersCollection.countDocuments({
            role: "citizen",
          });

          // ===== ISSUES =====
          const totalIssues = await issuesCollection.countDocuments();
          const resolvedIssues = await issuesCollection.countDocuments({
            status: "Resolved",
          });
          const pendingIssues = await issuesCollection.countDocuments({
            status: "Pending",
          });
          const rejectedIssues = await issuesCollection.countDocuments({
            status: "Rejected",
          });

          // ===== PAYMENTS =====
          const payments = await paymentsCollection.find().toArray();
          const totalPayments = payments.reduce(
            (sum, p) => sum + (p.amount || 0),
            0
          );

          // ===== ISSUE STATUS PIE =====
          const issueStatusData = [
            { name: "Resolved", value: resolvedIssues, color: "#22C55E" },
            { name: "Pending", value: pendingIssues, color: "#FACC15" },
            { name: "Rejected", value: rejectedIssues, color: "#EF4444" },
          ];

          // ===== MONTHLY ISSUES BAR =====
          const monthlyAggregation = await issuesCollection
            .aggregate([
              // ignore documents without createdAt
              { $match: { createdAt: { $exists: true, $ne: null } } },

              // convert string to Date if needed
              {
                $addFields: {
                  createdAtDate: {
                    $cond: [
                      { $eq: [{ $type: "$createdAt" }, "string"] },
                      { $toDate: "$createdAt" },
                      "$createdAt",
                    ],
                  },
                },
              },

              // group by month
              {
                $group: {
                  _id: { $month: "$createdAtDate" },
                  issues: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];
          const monthlyIssues = monthlyAggregation.map((item) => ({
            month: months[item._id - 1],
            issues: item.issues,
          }));

          // ===== LATEST DATA =====
          const latestIssues = await issuesCollection
            .find()
            .sort({ createdAt: -1 })
            .limit(5)
            .project({ title: 1, status: 1 })
            .toArray();

          const latestPayments = await paymentsCollection
            .find()
            .sort({ _id: -1 })
            .limit(5)
            .project({ name: 1, amount: 1 })
            .toArray();

          const latestUsers = await usersCollection
            .find()
            .sort({ _id: -1 })
            .limit(5)
            .project({ name: 1, email: 1 })
            .toArray();

          res.send({
            stats: {
              totalIssues,
              resolvedIssues,
              pendingIssues,
              rejectedIssues,
              totalPayments,
              totalUsers,
            },
            issueStatusData,
            monthlyIssues,
            latestIssues,
            latestPayments,
            latestUsers,
          });
        } catch (error) {
          console.log(error);
          res.status(500).send({ message: "Dashboard data fetch failed" });
        }
      }
    );

    // staff-dashboard home
    app.get(
      "/api/staff-dashboard",
      verifyJWT,
      verifySTAFF,
      async (req, res) => {
        try {
          const { email } = req.query; // staff email from frontend

          if (!email)
            return res.status(400).json({ message: "Email required" });

          // ===== ISSUES =====
          const totalAssigned = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
          });

          const resolved = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            status: "Resolved",
          });

          const pending = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            status: "Pending",
          });

          const inProgress = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            status: { $in: ["In-progress", "Working"] },
          });

          // Pie chart data
          const taskStatusData = [
            { name: "Resolved", value: resolved, color: "#22C55E" },
            { name: "In Progress", value: inProgress, color: "#3B82F6" },
            { name: "Pending", value: pending, color: "#FACC15" },
          ];

          // Bar chart for issue priority (Boosted or not)
          const highPriority = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            isBoosted: true,
          });
          const normalPriority = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            isBoosted: false,
          });
          const priorityData = [
            { name: "High", count: highPriority },
            { name: "Normal", count: normalPriority },
          ];

          // Weekly activity (last 7 days)
          const today = new Date();
          const last7Days = [...Array(7)].map((_, i) => {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            return {
              day: d.toLocaleDateString("en-US", { weekday: "short" }),
              assigned: 0,
              resolved: 0,
            };
          });

          const assignedIssues = await issuesCollection
            .find({
              assignedStaffEmail: email,
              createdAt: {
                $gte: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000),
              },
            })
            .toArray();

          assignedIssues.forEach((issue) => {
            const index = last7Days.findIndex(
              (d) =>
                d.day ===
                new Date(issue.createdAt).toLocaleDateString("en-US", {
                  weekday: "short",
                })
            );
            if (index !== -1) {
              last7Days[index].assigned += 1;
              if (issue.status === "Resolved") last7Days[index].resolved += 1;
            }
          });

          last7Days.reverse();

          // ===== Today Tasks =====
          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);
          const endOfToday = new Date();
          endOfToday.setHours(23, 59, 59, 999);

          const todayAssigned = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            createdAt: { $gte: startOfToday, $lte: endOfToday },
          });

          const todayPending = await issuesCollection.countDocuments({
            assignedStaffEmail: email,
            status: "Pending",
            createdAt: { $gte: startOfToday, $lte: endOfToday },
          });

          res.json({
            stats: {
              totalAssigned,
              resolved,
              pending,
              inProgress,
              todayAssigned,
              todayPending,
            },
            charts: {
              taskStatusData,
              priorityData,
              activityData: last7Days,
            },
          });
        } catch (error) {
          console.log("Staff dashboard error:", error);
          res
            .status(500)
            .json({ message: "Failed to fetch staff dashboard data" });
        }
      }
    );

    // user role
    app.get("/api/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
