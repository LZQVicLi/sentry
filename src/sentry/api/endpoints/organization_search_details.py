from django.db.models import Q
from rest_framework.request import Request
from rest_framework.response import Response

from sentry import analytics
from sentry.api.base import region_silo_endpoint
from sentry.api.bases.organization import OrganizationEndpoint, OrganizationSearchPermission
from sentry.api.exceptions import ResourceDoesNotExist
from sentry.models.organization import Organization
from sentry.models.savedsearch import SavedSearch, Visibility
from sentry.models.search_common import SearchType


@region_silo_endpoint
class OrganizationSearchDetailsEndpoint(OrganizationEndpoint):
    permission_classes = (OrganizationSearchPermission,)

    def delete(self, request: Request, organization: Organization, search_id: str) -> Response:
        """
        Permanently remove a saved search.

            {method} {path}

        """
        try:
            # Only allow users to delete their own personal searches OR
            # organization level searches
            org_search = Q(visibility=Visibility.ORGANIZATION)
            personal_search = Q(owner=request.user, visibility=Visibility.OWNER)

            search = SavedSearch.objects.get(
                org_search | personal_search,
                organization=organization,
                id=search_id,
            )
        except SavedSearch.DoesNotExist:
            raise ResourceDoesNotExist

        search.delete()
        analytics.record(
            "organization_saved_search.deleted",
            search_type=SearchType(search.type).name,
            org_id=organization.id,
            query=search.query,
        )
        return Response(status=204)
