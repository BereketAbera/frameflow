# Frameflow UI system

Frameflow follows the [shadcn/ui](https://ui.shadcn.com/docs) design-system approach: open component code, semantic tokens, composition, accessible states, and consistent variants. The interface is a Next.js App Router application using React, TypeScript, and Tailwind CSS v4. Reusable primitives live in `components/ui`, are owned by the repository, and can be adapted without wrapping a third-party black box.

## Semantic tokens

The CSS variables in `app/globals.css` define the same token categories used by shadcn:

- `background` / `foreground`
- `card` / `card-foreground`
- `popover` / `popover-foreground`
- `primary` / `primary-foreground`
- `secondary` / `secondary-foreground`
- `muted` / `muted-foreground`
- `accent` / `accent-foreground`
- `destructive`, `border`, `input`, and `ring`
- a shared `radius` scale

Frameflow adds only three product semantics: `brand`, `success`, and `info`.

## Component mapping

| Frameflow pattern | shadcn reference | Usage |
| --- | --- | --- |
| `Button` variants | Button | Primary actions, outline actions, ghost actions |
| `Card` composition | Card | Upload surface, statistics, service state, details |
| `Input` + native label | Field + Input | Supabase sign-in and sign-up |
| `Badge` status variants | Badge | Upload and workflow status |
| `Progress` | Progress | Direct object-storage upload |
| Composed `Link` row | Item | Video title, metadata, state, and navigation action |
| Card composition | Empty / Skeleton | First-run and loading states |

## Rules for future UI work

1. Use semantic tokens; do not introduce raw neutral colors inside reusable components.
2. Extend an existing variant before creating a one-off button, badge, input, or card style.
3. Keep focus-visible rings, disabled states, labels, and meaningful empty/loading/error states.
4. Compose screens from the patterns above so authentication, dashboard, and player remain visually related.
5. Keep product accent colors separate from interaction semantics such as destructive, success, and info.
6. Keep `components.json` aligned with the local aliases and add new primitives as source-owned components in `components/ui`.

Official references:

- [AI-readable component index](https://ui.shadcn.com/llms.txt)
- [Component examples](https://ui.shadcn.com/docs/components)
- [Theming](https://ui.shadcn.com/docs/theming)
