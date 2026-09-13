// Anchor: LeetCode GraphQL query constants (ISOLATED world, classic script).
// Sends: nothing (pure constants; no messages).
// Receives: nothing.
// Consumed by lc-client.js via globalThis.AnchorQueries.
// Source: lc-research/extract.js, verbatim minus runtimeDisplay/memoryDisplay; Q_PROBLEM includes content.

(function () {
  'use strict';

  const Q_WHOAMI = `query globalData { userStatus { userId username isSignedIn isPremium } }`;
  const Q_SKILLS = `query skillStats($username: String!) { matchedUser(username: $username) { tagProblemCounts { advanced { tagName tagSlug problemsSolved } intermediate { tagName tagSlug problemsSolved } fundamental { tagName tagSlug problemsSolved } } } }`;
  const Q_PROGRESS = `query userProfileUserQuestionProgressV2($userSlug: String!) { userProfileUserQuestionProgressV2(userSlug: $userSlug) { numAcceptedQuestions { count difficulty } numFailedQuestions { count difficulty } numUntouchedQuestions { count difficulty } } }`;
  const Q_LIST_V2 = `query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $skip: Int, $categorySlug: String) {
  problemsetQuestionListV2(filters: $filters, limit: $limit, skip: $skip, categorySlug: $categorySlug) {
    questions { id titleSlug title questionFrontendId paidOnly difficulty status acRate topicTags { name slug } }
    totalLength finishedLength hasMore
  }
}`;
  const Q_LIST_V1 = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
    total: totalNum
    questions: data { titleSlug title frontendQuestionId: questionFrontendId paidOnly: isPaidOnly difficulty status acRate topicTags { name slug } }
  }
}`;
  const Q_SUBS_FOR_PROBLEM = `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
  questionSubmissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
    lastKey hasNext
    submissions { id title titleSlug status statusDisplay lang langName runtime timestamp url isPending memory }
  }
}`;
  const Q_DETAILS = `query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    runtime runtimePercentile memory memoryPercentile
    code timestamp statusCode
    lang { name verboseName }
    question { questionId titleSlug }
    notes topicTags { slug }
    runtimeError compileError lastTestcase codeOutput expectedOutput totalCorrect totalTestcases fullCodeOutput
  }
}`;
  const Q_PROBLEM = `query questionDetail($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId questionFrontendId title titleSlug difficulty isPaidOnly acRate
    topicTags { name slug } similarQuestions hints stats
    content
  }
}`;

  globalThis.AnchorQueries = Object.freeze({
    Q_WHOAMI, Q_LIST_V2, Q_LIST_V1, Q_SKILLS, Q_PROGRESS, Q_SUBS_FOR_PROBLEM, Q_DETAILS, Q_PROBLEM
  });
})();
