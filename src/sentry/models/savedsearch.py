from django.db import models
from django.db.models import Q, UniqueConstraint
from django.utils import timezone
from django.utils.translation import ugettext_lazy as _

from sentry.db.models import FlexibleForeignKey, Model, region_silo_only_model, sane_repr
from sentry.db.models.fields.text import CharField
from sentry.models.search_common import SearchType


class SortOptions:
    DATE = "date"
    NEW = "new"
    PRIORITY = "priority"
    FREQ = "freq"
    USER = "user"
    TREND = "trend"
    INBOX = "inbox"

    @classmethod
    def as_choices(cls):
        return (
            (cls.DATE, _("Last Seen")),
            (cls.NEW, _("First Seen")),
            (cls.PRIORITY, _("Priority")),
            (cls.FREQ, _("Events")),
            (cls.USER, _("Users")),
            (cls.TREND, _("Relative Change")),
            (cls.INBOX, _("Date Added")),
        )


class Visibility:
    ORGANIZATION = "organization"
    OWNER = "owner"
    OWNER_PINNED = "owner_pinned"

    @classmethod
    def as_choices(cls, include_pinned):
        # Note that the pinned value may not always be a visibility we want to
        # expose. The pinned search API explicitly will set this visibility,
        # but the saved search API should not allow it to be set
        choices = [
            (cls.ORGANIZATION, _("Organization")),
            (cls.OWNER, _("Only for me")),
        ]
        if include_pinned:
            choices.append((cls.OWNER_PINNED, _("My Pinned Search")))

        return choices


@region_silo_only_model
class SavedSearch(Model):
    """
    A saved search query.
    """

    __include_in_export__ = True
    organization = FlexibleForeignKey("sentry.Organization", null=True)
    type = models.PositiveSmallIntegerField(default=SearchType.ISSUE.value, null=True)
    name = models.CharField(max_length=128)
    query = models.TextField()
    sort = CharField(
        max_length=16, default=SortOptions.DATE, choices=SortOptions.as_choices(), null=True
    )
    date_added = models.DateTimeField(default=timezone.now)

    # Global searches exist for ALL organizations. A savedsearch marked with
    # is_global does NOT have an associated organization_id
    is_global = models.NullBooleanField(null=True, default=False, db_index=True)

    # XXX(epurkhiser): This is different from "creator". Owner is a misnomer
    # for this column, as this actually indicates that the search is "pinned"
    # by the user. A user may only have one pinned search epr (org, type)
    #
    # XXX(epurkhiser): Once the visibility column is correctly in use this
    # column will be used essentially as "created_by"
    owner = FlexibleForeignKey("sentry.User", null=True)

    # Defines who can see the saved search
    #
    # NOTE: `owner_pinned` has special behavior in that the saved search will
    # not appear in the user saved search list
    visibility = models.CharField(
        max_length=16, default=Visibility.OWNER, choices=Visibility.as_choices(include_pinned=True)
    )

    class Meta:
        app_label = "sentry"
        db_table = "sentry_savedsearch"
        unique_together = ()
        constraints = [
            # Each user may only have one pinned search
            UniqueConstraint(
                fields=["organization", "owner", "type"],
                condition=Q(visibility=Visibility.OWNER_PINNED),
                name="sentry_savedsearch_pinning_constraint",
            ),
            # Global saved searches should not have name overlaps
            UniqueConstraint(
                fields=["is_global", "name"],
                condition=Q(is_global=True),
                name="sentry_savedsearch_organization_id_313a24e907cdef99",
            ),
        ]

    @property
    def is_pinned(self):
        return self.visibility == Visibility.OWNER_PINNED

    __repr__ = sane_repr("project_id", "name")


# TODO: Remove once we've completely removed sentry 9
@region_silo_only_model
class SavedSearchUserDefault(Model):
    """
    Indicates the default saved search for a given user
    """

    __include_in_export__ = True

    savedsearch = FlexibleForeignKey("sentry.SavedSearch")
    project = FlexibleForeignKey("sentry.Project")
    user = FlexibleForeignKey("sentry.User")

    class Meta:
        unique_together = (("project", "user"),)
        app_label = "sentry"
        db_table = "sentry_savedsearch_userdefault"
