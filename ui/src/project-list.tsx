import { S, enc, fmt, LANES, type Home } from "./lib/api";
import { Card, Hint } from "./shared";

function Progress({ percent }: { percent: number }) {
  return (
    <div className="progress" title={fmt(S.projects.progress, { percent })}>
      <i style={{ width: percent + "%" }} />
    </div>
  );
}
function projectProgress(p: Home["projects"][number]) {
  const total = LANES.reduce((n, [k]) => n + p.lanes[k], 0);
  const percent = total ? Math.round((p.lanes.done / total) * 100) : 0;
  const notes = total
    ? [
        fmt(S.projects.progress, { percent }),
        p.lanes.needsYou
          ? fmt(S.projects.needCount, { count: p.lanes.needsYou })
          : "",
        p.lanes.inReview
          ? fmt(S.projects.reviewCount, { count: p.lanes.inReview })
          : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : S.projects.noTasks;
  return { percent, notes };
}

export function ProjectList({
  projects,
  active,
}: {
  projects: Home["projects"];
  active?: string;
}) {
  return (
    <aside className="project-list">
      <h2>{S.projects.all}</h2>
      {projects.length ? (
        projects.map((p) => {
          const { percent, notes } = projectProgress(p);
          return (
            <a
              className="card-link"
              key={p.name}
              href={"#/project/" + enc(p.name)}
              aria-current={p.name === active ? "page" : undefined}
            >
              <Card className="panel">
                <h3>{p.name}</h3>
                <p className="mono truncate" title={p.path}>
                  {p.path}
                </p>
                <Progress percent={percent} />
                <Hint>{notes}</Hint>
              </Card>
            </a>
          );
        })
      ) : (
        <Hint>{S.projects.empty}</Hint>
      )}
    </aside>
  );
}
