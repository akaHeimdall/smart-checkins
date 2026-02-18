import { getGraphClient, getUserPath } from "../graph";
import { createChildLogger } from "../logger";
import type { TodoTask, TodoList } from "../types";

const log = createChildLogger("collector-tasks");

interface GraphTaskListResponse {
  value: Array<{
    id: string;
    displayName: string;
  }>;
}

interface GraphTaskResponse {
  value: Array<{
    id: string;
    title: string;
    dueDateTime?: { dateTime: string; timeZone: string };
    importance: string;
    status: string;
  }>;
}

// ── Cached list IDs (fetched once at startup) ─────────────────────

let _todoLists: TodoList[] | null = null;

export async function fetchTodoLists(): Promise<TodoList[]> {
  if (_todoLists) return _todoLists;

  try {
    // Use the Graph client directly — the To Do API is sensitive to
    // query parameter encoding, so we avoid the graphGet wrapper
    const client = getGraphClient();
    const userPath = getUserPath();
    const response = await client
      .api(`${userPath}/todo/lists`)
      .get() as GraphTaskListResponse;

    _todoLists = response.value.map((list) => ({
      id: list.id,
      displayName: list.displayName,
    }));

    log.info(
      { lists: _todoLists.map((l) => l.displayName) },
      "Fetched To Do lists"
    );
    return _todoLists;
  } catch (error) {
    log.error({ error }, "Failed to fetch To Do lists");
    throw error;
  }
}

// ── Fetch open tasks from all lists ───────────────────────────────

export async function fetchOpenTasks(): Promise<TodoTask[]> {
  const lists = await fetchTodoLists();
  const allTasks: TodoTask[] = [];
  const client = getGraphClient();
  const userPath = getUserPath();

  for (const list of lists) {
    try {
      // Fetch all tasks and filter client-side — the To Do API's
      // $filter via the Graph SDK causes ParseUri errors
      const response = await client
        .api(`${userPath}/todo/lists/${list.id}/tasks`)
        .get() as GraphTaskResponse;

      const tasks: TodoTask[] = response.value
        .filter((task) => task.status !== "completed")
        .map((task) => ({
          id: task.id,
          listId: list.id,
          listName: list.displayName,
          title: task.title,
          dueDateTime: task.dueDateTime?.dateTime,
          importance: normalizeImportance(task.importance),
          status: task.status,
        }));

      allTasks.push(...tasks);
    } catch (error) {
      log.warn(
        { listId: list.id, listName: list.displayName, error },
        "Failed to fetch tasks from list — skipping"
      );
    }
  }

  log.info({ count: allTasks.length }, "Fetched open tasks across all lists");
  return allTasks;
}

// ── Create a task from an email ──────────────────────────────────

export async function createTaskFromEmail(opts: {
  subject: string;
  sender: string;
  emailId?: string;
}): Promise<{ success: boolean; taskTitle: string }> {
  const lists = await fetchTodoLists();
  if (lists.length === 0) {
    throw new Error("No To Do lists found");
  }

  const client = getGraphClient();
  const userPath = getUserPath();
  const listId = lists[0].id; // Use the default (first) list

  const taskTitle = `Follow up: ${opts.subject} (from ${opts.sender})`;

  const payload: Record<string, unknown> = {
    title: taskTitle,
    importance: "high",
    body: {
      content: `Created by Smart Check-ins from email.\nSender: ${opts.sender}\nSubject: ${opts.subject}`,
      contentType: "text",
    },
  };

  try {
    await client
      .api(`${userPath}/todo/lists/${listId}/tasks`)
      .post(payload);

    log.info({ taskTitle, listId, emailId: opts.emailId }, "Task created from email");
    return { success: true, taskTitle };
  } catch (error) {
    log.error({ error, taskTitle }, "Failed to create task from email");
    throw error;
  }
}

// ── Normalize Graph importance values ─────────────────────────────

function normalizeImportance(value: string): "low" | "normal" | "high" {
  switch (value.toLowerCase()) {
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "normal";
  }
}
