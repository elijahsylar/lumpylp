import { PageHeader, SectionTitle } from '../components/PageHeader';

const LAST_AUDITED = '2026-04-26';
const CONTACT_EMAIL = 'a11y@lumpylp.example';

export function Accessibility() {
  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader>
        <SectionTitle label="accessibility" />
        <p className="text-xs text-body-dim mt-1 uppercase tracking-wider">
          built for everyone — last audited {LAST_AUDITED}
        </p>
      </PageHeader>

      <section className="px-4 sm:px-6 pb-10 max-w-2xl bg-bg">
        <div className="space-y-6 text-sm text-body leading-relaxed">

          <p>
            LumpyLP is built so anyone can browse, vote, and listen — keyboard
            users, screen reader users, people with low vision, people with
            color vision differences, and people who can't tolerate motion.
            We treat accessibility as a feature, not a checklist.
          </p>

          <div>
            <h3 className="text-accent uppercase tracking-[0.2em] text-xs mb-2">
              what we commit to
            </h3>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong className="text-white">WCAG 2.2 Level AA</strong> across
                all interactive surfaces — color contrast, keyboard reachability,
                focus visibility, target sizes, error identification.
              </li>
              <li>
                Selected <strong className="text-white">WCAG 2.2 Level AAA</strong> where
                we can manage it without compromising the design — especially
                contrast on primary text and uninterrupted keyboard operation.
              </li>
              <li>
                <strong className="text-white">Semantic HTML first.</strong> Real
                buttons, real labels, real landmarks. ARIA only when the platform
                doesn't give us the right primitive.
              </li>
              <li>
                <strong className="text-white">Respect for system preferences:</strong>{' '}
                if you've asked your OS to reduce motion or increase contrast,
                LumpyLP picks that up automatically.
              </li>
              <li>
                No autoplay. No flashing content. No anti-features that punish
                assistive tech.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-accent uppercase tracking-[0.2em] text-xs mb-2">
              how we test
            </h3>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong className="text-white">axe-core</strong> automated scan on
                every page in the app. We aim for zero violations.
              </li>
              <li>
                <strong className="text-white">Keyboard-only walkthroughs</strong> of
                the core flows: signup, login, vote, add to lump, reorder a
                lump.
              </li>
              <li>
                <strong className="text-white">Screen reader passes</strong> with
                NVDA on Windows and VoiceOver on macOS / iOS.
              </li>
              <li>
                <strong className="text-white">Color blindness simulation</strong> via
                Chrome DevTools' vision deficiency emulator (achromatopsia,
                deuteranopia, protanopia, tritanopia) — every state we surface is
                designed to remain distinguishable in monochrome.
              </li>
              <li>
                <strong className="text-white">prefers-reduced-motion</strong> and{' '}
                <strong className="text-white">prefers-contrast: more</strong> verified
                in both Chrome and Safari.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-accent uppercase tracking-[0.2em] text-xs mb-2">
              what's currently rough
            </h3>
            <p className="mb-2">
              We're not perfect. Things we know about and want to improve:
            </p>
            <ul className="space-y-2 list-disc pl-5 text-body-dim">
              <li>
                The infinite scroll on the home and artists pages doesn't yet
                announce newly-loaded items to screen readers. Items are
                discoverable, but you won't hear that they appeared.
              </li>
              <li>
                The drag-to-reorder handle in lumps is keyboard-operable
                (Tab, Space, arrow keys, Space) but the move feedback isn't
                spoken yet — you'll have to navigate back to confirm position.
              </li>
              <li>
                We test in NVDA and VoiceOver but haven't yet validated against
                JAWS or TalkBack. If you use one of those, we'd love your
                feedback.
              </li>
              <li>
                The Major Mono Display wordmark in the sidebar is a stylistic
                font that may render unclearly at high zoom levels. The page
                title and all body text use a clearer mono.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-accent uppercase tracking-[0.2em] text-xs mb-2">
              found a problem? tell us
            </h3>
            <p>
              If anything on LumpyLP isn't working for you with assistive tech,
              email{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-accent-bright underline hover:text-white transition-colors"
              >
                {CONTACT_EMAIL}
              </a>{' '}
              with the page, your assistive tech (and version), and what you
              were trying to do. We treat accessibility bugs as P0 and aim to
              respond within a week.
            </p>
          </div>

          <div className="pt-4 border-t border-accent-dim/40">
            <p className="text-xs text-body-very-dim uppercase tracking-[0.2em]">
              last full audit: {LAST_AUDITED} · standards target: WCAG 2.2 AA
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
