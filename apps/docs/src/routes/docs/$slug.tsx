import { createFileRoute } from "@tanstack/react-router";
import { DocsShell, type TocItem } from "../../components/DocsShell.js";
import { GuideArticle } from "../../components/GuideArticle.js";
import { GUIDE_PAGES, getGuideBySlug } from "../../data/guides.js";

export const Route = createFileRoute("/docs/$slug")({
  component: GuidePageRoute,
});

function GuidePageRoute() {
  const { slug } = Route.useParams();
  const guide =
    GUIDE_PAGES.find((g) => g.slug === slug) ?? getGuideBySlug(slug);

  const tocItems: TocItem[] = guide.sections.map((section) => ({
    id: section.id,
    label: section.heading,
  }));

  return (
    <DocsShell tocItems={tocItems} tocTitle="On this page">
      <GuideArticle guide={guide} />
    </DocsShell>
  );
}
