'use strict';
/**
 * lib/taskDispatch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Task dispatch layer for LocalIntel.
 *
 * Flow:
 *   0-result search  → createTask()    → insert into tasks
 *                    → matchAgent()    → SELECT best agent (tier/verified/rating)
 *                    → assignTask()    → UPDATE status='assigned'
 *                    → notifyAgent()   → SMS via existing Twilio sender (rfqBroadcast.sendSms)
 *
 *   Twilio inbound   → handleAgentReply()
 *                      ├─ YES   → status='accepted', returns full task details
 *                      ├─ NO    → status='open', assigned_agent_id=NULL
 *                      ├─ DONE  → status='completed', tasks_completed++
 *                      └─ FAIL  → status='failed', logs reason
 *
 * Tables: agents, tasks, task_events (see migrations/006_tasks_agents.sql).
 *
 * db.query() returns array directly — never .rows.
 */

const db = require('./db');
const { sendSms } = require('./rfqBroadcast');

function _urgencyLabel(urgency) {
  if (urgency === 'now')   return '🚨 URGENT';
  if (urgency === 'today') return 'Today';
  return 'New task';
}

async function createTask(intent, query, zip) {
  // Extract urgency from query
  const urgency = /\bnow\b|\basap\b|\burgent\b|\bemergency\b|\bright now\b/i.test(query)
    ? 'now'
    : /\btoday\b|\btonight\b/i.test(query)
      ? 'today'
      : 'low';

  const row = await db.query(`
    INSERT INTO tasks (user_query, top_category, sub_category, entities_json, urgency, zip, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'open')
    RETURNING *
  `, [
    query,
    intent && intent.categories ? intent.categories[0] || null : null,
    intent && intent.categories ? intent.categories[1] || null : null,
    JSON.stringify({
      categories: (intent && intent.categories) || [],
      cuisines:   (intent && intent.cuisines)   || [],
    }),
    urgency,
    zip || null,
  ]);

  const task = row[0];

  // Log creation event
  await db.query(`
    INSERT INTO task_events (task_id, event_type, meta)
    VALUES ($1, 'created', $2)
  `, [task.task_id, JSON.stringify({ query, intent })]);

  return task;
}

async function matchAgent(task) {
  const agents = await db.query(`
    SELECT * FROM agents
    WHERE available = true
      AND (
        $1 = ANY(zips_served) OR zip = $1
      )
      AND (
        '*' = ANY(categories)
        OR $2 = ANY(categories)
      )
    ORDER BY
      CASE tier WHEN 'owner' THEN 0 WHEN 'vetted' THEN 1 ELSE 2 END ASC,
      verified DESC,
      rating DESC,
      tasks_completed DESC
    LIMIT 1
  `, [task.zip, task.top_category]);

  return agents[0] || null;
}

async function assignTask(task, agent) {
  await db.query(`
    UPDATE tasks
       SET status = 'assigned',
           assigned_agent_id = $1,
           assigned_at = NOW()
     WHERE task_id = $2
  `, [agent.agent_id, task.task_id]);

  await db.query(`
    INSERT INTO task_events (task_id, agent_id, event_type, meta)
    VALUES ($1, $2, 'assigned', $3)
  `, [task.task_id, agent.agent_id, JSON.stringify({ agent_name: agent.name })]);
}

async function notifyAgent(task, agent) {
  const shortId = String(task.task_id).slice(0, 8);
  const label   = _urgencyLabel(task.urgency);
  const body    = `[TASK-${shortId}] ${label}: "${task.user_query}" in ${task.zip || 'your area'}. Reply YES to accept or NO to pass.`;

  try {
    const ok = await sendSms(agent.phone, body);
    return ok;
  } catch (e) {
    console.error('[taskDispatch] notifyAgent SMS error:', e.message);
    return false;
  }
}

async function dispatchTask(intent, query, zip) {
  const task = await createTask(intent, query, zip);
  const agent = await matchAgent(task);
  if (agent) {
    await assignTask(task, agent);
    await notifyAgent(task, agent);
  }
  return task;
}

async function handleAgentReply(fromPhone, body) {
  if (!fromPhone || !body) return null;
  const text = body.trim().toUpperCase();

  // Find the agent
  const agentRows = await db.query(
    `SELECT * FROM agents WHERE phone = $1 LIMIT 1`,
    [fromPhone]
  );
  const agent = agentRows[0];
  if (!agent) return null;

  // Resolve which task this reply refers to
  const taskRef = body.match(/\[TASK-([a-f0-9-]{8,})\]/i);
  let task;
  if (taskRef) {
    const tasks = await db.query(
      `SELECT * FROM tasks
        WHERE task_id::text LIKE $1
          AND assigned_agent_id = $2
        LIMIT 1`,
      [taskRef[1] + '%', agent.agent_id]
    );
    task = tasks[0];
  } else {
    // Fall back to most recent active task for this agent
    const tasks = await db.query(`
      SELECT * FROM tasks
       WHERE assigned_agent_id = $1
         AND status IN ('assigned','accepted','in_progress')
       ORDER BY assigned_at DESC
       LIMIT 1
    `, [agent.agent_id]);
    task = tasks[0];
  }

  if (!task) return null;

  if (text.startsWith('YES')) {
    await db.query(
      `UPDATE tasks SET status = 'accepted' WHERE task_id = $1`,
      [task.task_id]
    );
    await db.query(
      `INSERT INTO task_events (task_id, agent_id, event_type) VALUES ($1, $2, 'accepted')`,
      [task.task_id, agent.agent_id]
    );
    return {
      action: 'accepted',
      task,
      reply: `Task accepted! "${task.user_query}" in ${task.zip || 'your area'}. Reply DONE <notes> when complete, or FAIL <reason> if unable.`,
    };
  }

  if (text.startsWith('NO')) {
    await db.query(
      `UPDATE tasks SET status = 'open', assigned_agent_id = NULL WHERE task_id = $1`,
      [task.task_id]
    );
    await db.query(
      `INSERT INTO task_events (task_id, agent_id, event_type) VALUES ($1, $2, 'declined')`,
      [task.task_id, agent.agent_id]
    );
    return { action: 'declined', task };
  }

  if (text.startsWith('DONE')) {
    const notes = body.replace(/^DONE\s*/i, '').trim();
    await db.query(`
      UPDATE tasks
         SET status = 'completed',
             completed_at = NOW(),
             result_json = $1
       WHERE task_id = $2
    `, [JSON.stringify({ notes, completed_by: agent.name }), task.task_id]);
    await db.query(`
      UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE agent_id = $1
    `, [agent.agent_id]);
    await db.query(
      `INSERT INTO task_events (task_id, agent_id, event_type, meta) VALUES ($1, $2, 'completed', $3)`,
      [task.task_id, agent.agent_id, JSON.stringify({ notes })]
    );
    return { action: 'completed', task, reply: 'Task marked complete. Thank you!' };
  }

  if (text.startsWith('FAIL')) {
    const reason = body.replace(/^FAIL\s*/i, '').trim();
    await db.query(`
      UPDATE tasks SET status = 'failed', result_json = $1 WHERE task_id = $2
    `, [JSON.stringify({ reason }), task.task_id]);
    await db.query(
      `INSERT INTO task_events (task_id, agent_id, event_type, meta) VALUES ($1, $2, 'failed', $3)`,
      [task.task_id, agent.agent_id, JSON.stringify({ reason })]
    );
    return { action: 'failed', task };
  }

  return null;
}

module.exports = {
  createTask,
  matchAgent,
  assignTask,
  notifyAgent,
  handleAgentReply,
  dispatchTask,
};
