import express from "express";
import Database from "better-sqlite3";
const cors = require("cors");

const app = express();

// Enable CORS for all routes
app.use(cors());

app.use(express.json());

app.get("/", (req, res) => {
  return res
    .status(200)
    .send({ message: "SHIPTIVITY API. Read documentation to see API docs" });
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database("./clients.db");

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on("SIGTERM", closeDb);
process.on("SIGINT", closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
        message: "Invalid id provided.",
        long_message: "Id can only be integer.",
      },
    };
  }
  const client = db
    .prepare("select * from clients where id = ? limit 1")
    .get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
        message: "Invalid id provided.",
        long_message: "Cannot find client with that id.",
      },
    };
  }
  return {
    valid: true,
  };
};

/**
 * Check if a variable is a number
 * @param {any} number - variable to check
 * @returns {boolean}
 * */
function isNumber(n) {
  return typeof n === "number" && !isNaN(n);
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  // check if priority is a number and positive
  if (Number.isNaN(priority) || !isNumber(priority) || priority < 0) {
    return {
      valid: false,
      messageObj: {
        message: "Invalid priority provided.",
        long_message: "Priority can only be positive integer.",
      },
    };
  }
  return {
    valid: true,
  };
};

/**
 * Rotate priority in the same status
 * @param {Array} clients - clients with the same status
 * @param {number} oldPriority - old priority
 * @param {number} newPriority - new priority
 * @returns {Array} clients with updated priority
 */
const rotatePriority = (clients, oldPriority, newPriority) => {
  let pos1 = oldPriority - 1;
  let pos2 = newPriority - 1;

  let tmp = clients[pos1].priority;
  // move element down and shift other elements up
  if (pos1 > pos2) {
    for (let i = pos2; i < pos1; i++) {
      clients[i].priority = clients[i + 1].priority;
    }
  }
  //  move element up and shift other elements down
  else {
    for (let i = pos2; i > pos1; i--) {
      clients[i].priority = clients[i - 1].priority;
    }
  }
  // update priority
  clients[pos1].priority = newPriority;

  return clients;
};

/**
 * When a client, is added to a different status,
 * the priority rest of client need to be updated.
 * Add client to the clients array
 * @param {Array} clients - clients with the same status
 * @param {number} priority - new priority of client
 * @param {Object} client - client to add
 * @param {string} status - status of client
 * @returns {Array} updated clients
 */
const addClientAtPriority = (clients, priority, client, status) => {
  // create client copy
  let clientCopy = Object.assign({}, client);
  // update client priority
  clientCopy.priority = priority;
  clientCopy.status = status;
  // match priority with index
  const index = priority - 1;
  // add client to the clients array at index priority - 1
  clients.splice(index, 0, clientCopy);
  // shift other elements down
  for (let i = index + 1; i < clients.length; i++) {
    clients[i].priority = clients[i].priority + 1;
  }

  return clients;
};

/**
 * When a client, is added to a different status,
 * that client need to removed from previous clients array.
 * Remove client from the clients array
 * @param {Array} clients - clients with the same status
 * @param {number} index - index to remove client
 * @returns {Array} updated clients
 * */
const removeClientOfPriority = (clients, index) => {
  // shift other elements down
  for (let i = index; i < clients.length - 1; i++) {
    clients[i] = clients[i + 1];
    clients[i + 1].priority = clients[i + 1].priority - 1;
  }
  // remove last element
  clients.pop();
  return clients;
};

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get("/api/v1/clients", (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (
      status !== "backlog" &&
      status !== "in-progress" &&
      status !== "complete"
    ) {
      return res.status(400).send({
        message: "Invalid status provided.",
        long_message:
          "Status can only be one of the following: [backlog | in-progress | complete].",
      });
    }
    const clients = db
      .prepare("select * from clients where status = ?")
      .all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare("select * from clients");
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get("/api/v1/clients/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res
    .status(200)
    .send(db.prepare("select * from clients where id = ?").get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put("/api/v1/clients/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  let clients = db.prepare("select * from clients").all();
  const client = clients.find((client) => client.id === id);

  /* ---------- Update code below ----------*/
  // return error if both priority and status are null
  if (!priority && !status) {
    return res.status(400).send({
      message: "Failed to update swinelane.",
      long_message: "Priority and Status is null.",
    });
  }

  // no change to priority and status
  if (priority === client.priority && status === client.status) {
    return res.status(200).send(clients);
  }

  // set priority and status if they are null
  if (!priority) {
    priority = client.priority;
  }
  if (!status) {
    status = client.status;
  }

  // filter clients by status and sort by priority
  let clientsFilterByStatus = clients
    .filter((client) => client.status === status)
    .sort((a, b) => a.priority - b.priority);

  // validate status, if it is not null and should be one of the following: 'backlog' | 'in-progress' | 'complete'
  if (
    status !== "backlog" &&
    status !== "in-progress" &&
    status !== "complete"
  ) {
    return res.status(400).send({
      message: "Invalid status provided.",
      long_message:
        "Status can only be one of the following: [backlog | in-progress | complete].",
    });
  }

  // validate priority
  let validatePriorityObj = validatePriority(priority);
  if (validatePriorityObj.valid) {
    // check if priority is greater than the number of clients in the same status + 1
    if (
      priority > clientsFilterByStatus.length + 1 ||
      (client.status === status && priority > clientsFilterByStatus.length)
    ) {
      if (client.status === status) {
        // if client is in the same status then set priority to move at end of the status
        priority = clientsFilterByStatus.length;
        if (priority === client.priority) {
          // if priority is the same then return clients
          return res.status(200).send(clients);
        }
      } else {
        // if client is not in the same status then set priority to move at end of the status + 1
        priority = clientsFilterByStatus.length + 1;
      }

      // Alternative: return error if priority is greater than the number of clients in the same status + 1
      // return res.status(400).send({
      //   message: "Invalid priority provided.",
      //   long_message:
      //     "Priority cannot be greater than the number of clients in the same status + 1.",
      // });
    }

    // check if the client is in the same status
    if (client.status === status) {
      // rotate priority in the same status and set to clientsFilterByStatus
      clientsFilterByStatus = rotatePriority(
        clientsFilterByStatus,
        client.priority,
        priority
      );
    } else {
      // filter clients by old status and sort by priority
      let clientsFilterByOldStatus = clients
        .filter((c) => c.status === client.status)
        .sort((a, b) => a.priority - b.priority);
      // remove client from old status array and shift other elements
      clientsFilterByOldStatus = removeClientOfPriority(
        clientsFilterByOldStatus,
        client.priority - 1
      );
      // add client to new status array and shift other elements
      clientsFilterByStatus = addClientAtPriority(
        clientsFilterByStatus,
        priority,
        client,
        status
      );
      // combine both, for easy database update
      clientsFilterByStatus = clientsFilterByStatus.concat(
        clientsFilterByOldStatus
      );
    }
  } else return res.status(400).send(validatePriorityObj.messageObj);

  // update database
  try {
    const updateClient = db.prepare(
      "update clients set status = @status, priority = @priority where id = @id"
    );

    let updateManyClients = db.transaction((clients) => {
      for (const client of clients) updateClient.run(client);
    });

    updateManyClients(clientsFilterByStatus);
  } catch (err) {
    console.log(err);
    return res.status(400).send({
      message: "Failed to update swinelane.",
      long_message: "Database error.",
    });
  }

  // filter clients excluding new status and old status clients
  clients = clients.filter(
    (c) => c.status !== status && c.status !== client.status
  );
  // concat clients with new status and old status clients and sort by status complete -> in-progress -> backlog
  clients = clients.concat(clientsFilterByStatus);

  // get updated clients
  return res.status(200).send(clients);
});
app.listen(3001);
console.log("app running on port ", 3001);
