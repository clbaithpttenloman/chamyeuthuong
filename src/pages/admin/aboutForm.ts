/**
 * src/pages/admin/aboutForm.ts — serializer for the About admin form.
 *
 * Converts the admin form's local state into the AboutContent shape
 * ready for PUT /api/admin/about. All string fields are trimmed.
 */
import type { AboutContent } from '../../../shared/api.ts'

export type AboutFormFields = {
  heading: string
  intro: string
  stats: Array<{ value: string; label: string }>
  stepsHeading: string
  steps: Array<{ when: string; title: string; text: string }>
  membersHeading: string
  members: Array<{ name: string; role: string }>
}

/** Serialize the admin form state into the AboutContent API shape. */
export function serializeAboutForm(fields: AboutFormFields): AboutContent {
  return {
    heading: fields.heading.trim(),
    intro: fields.intro.trim(),
    stats: fields.stats.map((s) => ({ value: s.value.trim(), label: s.label.trim() })),
    stepsHeading: fields.stepsHeading.trim(),
    steps: fields.steps.map((s) => ({ when: s.when.trim(), title: s.title.trim(), text: s.text.trim() })),
    membersHeading: fields.membersHeading.trim(),
    members: fields.members.map((m) => ({ name: m.name.trim(), role: m.role.trim() })),
  }
}
