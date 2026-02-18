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
      const response = await client
        .api(`${userPath}/todo/lists/${list.id}/tasks`)
        .filter("status ne 'completed'")
        .select("id,title,dueDateTime,importance,status")
        .get() as GraphTaskResponse;

      const tasks: TodoTask[] = response.value.map((task) => ({
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
