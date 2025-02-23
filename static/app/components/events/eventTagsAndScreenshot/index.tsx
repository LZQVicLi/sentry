import {useState} from 'react';
import styled from '@emotion/styled';

import {openModal} from 'sentry/actionCreators/modal';
import {DataSection} from 'sentry/components/events/styles';
import Link from 'sentry/components/links/link';
import {t, tct} from 'sentry/locale';
import space from 'sentry/styles/space';
import {EventAttachment} from 'sentry/types/group';
import {objectIsEmpty} from 'sentry/utils';
import trackAdvancedAnalyticsEvent from 'sentry/utils/analytics/trackAdvancedAnalyticsEvent';
import {SCREENSHOT_TYPE} from 'sentry/views/organizationGroupDetails/groupEventAttachments/groupEventAttachmentsFilter';
import {Tab, TabPaths} from 'sentry/views/organizationGroupDetails/types';

import Modal, {modalCss} from './screenshot/modal';
import {DataSection as ScreenshotDataSection} from './dataSection';
import Screenshot from './screenshot';
import Tags from './tags';
import TagsHighlight from './tagsHighlight';

type ScreenshotProps = React.ComponentProps<typeof Screenshot>;

const SCREENSHOT_NAMES = [
  'screenshot.jpg',
  'screenshot.png',
  'screenshot-1.jpg',
  'screenshot-1.png',
  'screenshot-2.jpg',
  'screenshot-2.png',
];

type Props = Omit<
  React.ComponentProps<typeof Tags>,
  'projectSlug' | 'hasEventContext'
> & {
  attachments: ScreenshotProps['screenshot'][];
  onDeleteScreenshot: ScreenshotProps['onDelete'];
  projectId: string;
  hasContext?: boolean;
  isShare?: boolean;
};

function EventTagsAndScreenshots({
  projectId: projectSlug,
  location,
  event,
  attachments,
  onDeleteScreenshot,
  organization,
  isShare = false,
  hasContext = false,
}: Props) {
  const {tags = []} = event;

  const screenshots = attachments.filter(({name}) => SCREENSHOT_NAMES.includes(name));

  const [screenshotInFocus, setScreenshotInFoucs] = useState<number>(0);

  if (!tags.length && !hasContext && (isShare || !screenshots.length)) {
    return null;
  }

  const showScreenshot = !isShare && !!screenshots.length;
  const screenshot = screenshots[screenshotInFocus];
  // Check for context bailout condition. No context is rendered if only user is provided
  const hasEventContext = hasContext && !objectIsEmpty(event.contexts);
  const showTags = !!tags.length || hasContext;

  function handleOpenVisualizationModal(
    eventAttachment: EventAttachment,
    downloadUrl: string
  ) {
    trackAdvancedAnalyticsEvent('issue_details.issue_tab.screenshot_modal_opened', {
      organization,
    });
    function handleDelete() {
      trackAdvancedAnalyticsEvent('issue_details.issue_tab.screenshot_modal_deleted', {
        organization,
      });
      onDeleteScreenshot(eventAttachment.id);
    }

    openModal(
      modalProps => (
        <Modal
          {...modalProps}
          event={event}
          orgSlug={organization.slug}
          projectSlug={projectSlug}
          eventAttachment={eventAttachment}
          downloadUrl={downloadUrl}
          onDelete={handleDelete}
          onDownload={() =>
            trackAdvancedAnalyticsEvent(
              'issue_details.issue_tab.screenshot_modal_download',
              {
                organization,
              }
            )
          }
        />
      ),
      {modalCss}
    );
  }

  const screenshotLink = (
    <Link
      to={{
        pathname: `${location.pathname}${TabPaths[Tab.ATTACHMENTS]}`,
        query: {...location.query, types: SCREENSHOT_TYPE},
      }}
    />
  );

  return (
    <Wrapper showScreenshot={showScreenshot} showTags={showTags}>
      {showScreenshot && (
        <div>
          <ScreenshotWrapper>
            <ScreenshotDataSection
              data-test-id="screenshot-data-section"
              title={
                screenshots.length > 1
                  ? tct('[current] of [total] [link:screenshots]', {
                      current: screenshotInFocus + 1,
                      total: screenshots.length,
                      link: screenshotLink,
                    })
                  : tct('[link:Screenshot]', {
                      link: screenshotLink,
                    })
              }
              description={t(
                'This image was captured around the time that the event occurred.'
              )}
            >
              <Screenshot
                organization={organization}
                eventId={event.id}
                projectSlug={projectSlug}
                screenshot={screenshot}
                onDelete={onDeleteScreenshot}
                openVisualizationModal={handleOpenVisualizationModal}
              />
            </ScreenshotDataSection>
          </ScreenshotWrapper>
          {screenshots.length > 1 && (
            <Container>
              {screenshots.map((s, index) => {
                return (
                  <IconEllipse
                    key={`${index}-${s.name}`}
                    role="button"
                    aria-label={tct('View [screenshotName]', {screenshotName: s.name})}
                    data-test-id={`screenshot-icon-${index}`}
                    inFocus={screenshotInFocus === index}
                    onClick={() => setScreenshotInFoucs(index)}
                  />
                );
              })}
            </Container>
          )}
        </div>
      )}
      {showScreenshot && (showTags || hasEventContext) && <VerticalDivider />}
      <TagWrapper hasEventContext={hasEventContext}>
        {hasEventContext && (
          <TagsHighlightWrapper>
            <TagsHighlight event={event} />
          </TagsHighlightWrapper>
        )}
        {showTags && (
          <Tags
            organization={organization}
            event={event}
            projectSlug={projectSlug}
            location={location}
          />
        )}
      </TagWrapper>
    </Wrapper>
  );
}

export default EventTagsAndScreenshots;

/**
 * Used to adjust padding based on which 3 elements are shown
 * - screenshot
 * - context
 * - tags
 */
const Wrapper = styled(DataSection)<{
  showScreenshot: boolean;
  showTags: boolean;
}>`
  padding: 0;

  @media (min-width: ${p => p.theme.breakpoints.small}) {
    padding: 0;
    display: grid;
    grid-template-columns: ${p =>
      p.showScreenshot && p.showTags ? 'max-content auto 1fr' : '1fr'};
  }
`;

const VerticalDivider = styled('div')`
  background: ${p => p.theme.innerBorder};
  height: 1px;
  width: 100%;

  @media (min-width: ${p => p.theme.breakpoints.small}) {
    height: 100%;
    width: 1px;
  }
`;

const ScreenshotWrapper = styled('div')`
  & > div {
    border: 0;
    height: 100%;
  }
`;

const TagWrapper = styled('div')<{hasEventContext: boolean}>`
  padding: ${p => (p.hasEventContext ? `${space(2)} 0` : '0')};
  overflow: hidden;

  @media (min-width: ${p => p.theme.breakpoints.small}) {
    padding: ${p => (p.hasEventContext ? `${space(2)} 0` : '0')};
  }
`;

const TagsHighlightWrapper = styled('div')`
  overflow: hidden;
  padding: 0 ${space(2)};

  @media (min-width: ${p => p.theme.breakpoints.medium}) {
    padding: 0 ${space(4)};
  }
`;

const IconEllipse = styled('div')<{
  inFocus: boolean;
}>`
  width: 6px;
  height: 6px;
  cursor: pointer;

  border-radius: 5px;
  background-color: ${p => (p.inFocus ? p.theme.gray300 : p.theme.gray100)};
`;

const Container = styled('div')`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
`;
